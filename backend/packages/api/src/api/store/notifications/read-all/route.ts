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
// The whole feed, newest first, a page at a time. It used to mark only the
// newest 50 while the badge counts every unread row, so a customer with more
// than 50 unread kept a badge "mark all read" could never clear (audit
// 2026-11-11). Reads live in a side table, so marking never reorders the feed
// and offset paging is stable; a row arriving mid-loop only shifts the window
// down by one, which re-reads a row, never skips one.
//
// MAX_ROWS bounds one request. A feed longer than that keeps the remainder
// unread; the response says so (`has_more`) and a second tap marks the rest.
const PAGE_SIZE = 200;
const MAX_ROWS = 5_000;

type Packs = PacksModuleService;

/** Mark this page's still-unread ids read. Returns how many rows it wrote. */
async function markPage(
  req: AuthenticatedMedusaRequest,
  packs: Packs,
  customerId: string,
  ids: string[],
  now: Date,
): Promise<number> {
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
  if (toCreate.length === 0) return 0;

  try {
    await packs.createNotificationReads(toCreate);
    return toCreate.length;
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
    // individually. Capped at one page, so the worst case is bounded, and
    // this path only runs on a real race.
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
    return persisted;
  }
}

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
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const now = new Date();

  let marked = 0;
  let offset = 0;
  let hasMore = false;
  for (;;) {
    const page = await notif.listNotifications(
      { receiver_id: customerId, channel: CUSTOMER_FEED_CHANNEL },
      {
        take: PAGE_SIZE,
        skip: offset,
        // id tiebreaker: batch creates share a created_at, and created_at
        // alone gives no stable order across offset pages.
        order: { created_at: 'DESC', id: 'DESC' },
      },
    );
    if (page.length > 0) {
      marked += await markPage(
        req,
        packs,
        customerId,
        page.map((n) => n.id),
        now,
      );
    }
    offset += page.length;
    if (page.length < PAGE_SIZE) break;
    if (offset >= MAX_ROWS) {
      hasMore = true;
      break;
    }
  }

  res.json({ marked, read_at: now.toISOString(), has_more: hasMore });
}
