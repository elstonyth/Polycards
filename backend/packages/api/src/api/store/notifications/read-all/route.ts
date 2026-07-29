import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules, MedusaError } from '@medusajs/framework/utils';
import type { INotificationModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { CUSTOMER_FEED_CHANNEL } from '../../../../modules/packs/notify-feed';

// POST /store/notifications/read-all
//
// Marks every currently-unread feed notification read for the authenticated
// customer, in one request.
//
// Why this exists: toasts are driven by a client-side watermark and never write
// read_at (so the bell badge and the toast keep answering different questions).
// That means notifications accumulate as unread indefinitely, and the per-id
// limiter (20/10s) makes a client-side loop over 50 rows impossible. This is
// the only way to clear the badge.
//
// Owner-scoping: receiver_id comes ONLY from the verified bearer token, never
// from the body. The write set is derived from that same owner-scoped list, so
// there is no id input to forge.
//
// Idempotent: rows that already have a notification_read entry are skipped, so
// a second call marks 0 and leaves the original timestamps intact.
//
// Auth + rate-limit middleware is registered in src/api/middlewares.ts.
//
// Page size mirrors RECENT_NOTIFICATIONS in the sibling list route: the feed UI
// only ever shows that page, so "mark all read" means "mark all the customer
// can actually see".
const RECENT_NOTIFICATIONS = 50;

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const notif = req.scope.resolve<INotificationModuleService>(
    Modules.NOTIFICATION,
  );
  const notifications = await notif.listNotifications(
    { receiver_id: customerId, channel: CUSTOMER_FEED_CHANNEL },
    { take: RECENT_NOTIFICATIONS, order: { created_at: 'DESC' } },
  );

  const now = new Date();
  if (notifications.length === 0) {
    res.json({ marked: 0, read_at: now.toISOString() });
    return;
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const ids = notifications.map((n) => n.id);
  const existing = await packs.listNotificationReads(
    { customer_id: customerId, notification_id: ids },
    { take: ids.length },
  );
  const alreadyRead = new Set(
    existing.map((r: { notification_id: string }) => r.notification_id),
  );

  const toCreate = ids
    .filter((id) => !alreadyRead.has(id))
    .map((id) => ({
      notification_id: id,
      customer_id: customerId,
      read_at: now,
    }));

  if (toCreate.length === 0) {
    res.json({ marked: 0, read_at: now.toISOString() });
    return;
  }

  try {
    await packs.createNotificationReads(toCreate);
    res.json({ marked: toCreate.length, read_at: now.toISOString() });
    return;
  } catch (err) {
    // Log every failure — not just the documented race — so operators can
    // diagnose real infra errors (DB timeout, connection drop, unrelated
    // bug), even when the recovery below fully accounts for it.
    try {
      (req.scope.resolve('logger') as { warn: (m: string) => void }).warn(
        `[store/notifications/read-all] createNotificationReads failed for customer ${customerId} (${toCreate.length} rows) — attempting per-row recovery: ${String(err)}`,
      );
    } catch {
      // logger not available in test container — silently ignore
    }

    // A unique-index violation on ANY row aborts the whole multi-row INSERT
    // — true whether or not the underlying batch is transactionally atomic —
    // so ids that never collided can be left unpersisted too. Re-derive what
    // is actually still missing from a fresh read and insert those
    // individually. Capped at RECENT_NOTIFICATIONS rows, so the worst case
    // is bounded, and this path only runs on a real race.
    const after = await packs.listNotificationReads(
      { customer_id: customerId, notification_id: ids },
      { take: ids.length },
    );
    const afterIds = new Set(
      after.map((r: { notification_id: string }) => r.notification_id),
    );
    const stillMissing = toCreate.filter(
      (row) => !afterIds.has(row.notification_id),
    );

    // Rows already accounted for by the fresh read (pre-existing or landed
    // via the failed bulk call itself) count as persisted by this request's
    // intent — only genuinely-still-missing rows need an individual insert.
    let persisted = toCreate.length - stillMissing.length;
    for (const row of stillMissing) {
      try {
        await packs.createNotificationReads(row);
        persisted += 1;
      } catch (rowErr) {
        // Row-level TOCTOU: a concurrent per-id mark-read may have won the
        // race between the re-read above and this insert. Re-check before
        // treating it as a genuine failure.
        const [nowExists] = await packs.listNotificationReads(
          { notification_id: row.notification_id, customer_id: customerId },
          { take: 1 },
        );
        if (!nowExists) {
          throw rowErr;
        }
      }
    }

    res.json({ marked: persisted, read_at: now.toISOString() });
  }
}
