import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  Modules,
  MedusaError,
} from '@medusajs/framework/utils';
import type { INotificationModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// POST /store/notifications/:id/read
//
// Marks an in-app feed notification as read for the authenticated customer.
//
// Only 'feed' channel notifications can be marked read here. Non-feed
// notifications (e.g. email, SMS) are not markable via this endpoint — the
// channel check in the IDOR guard returns 404 for any non-feed notification id.
//
// IDOR guard: the notification is fetched scoped to both the supplied id AND
// the verified bearer's actor_id as receiver_id — a missing row returns 404
// and never reveals whether that id belongs to another customer.
//
// Idempotent: if a notification_read row already exists for this
// (notification_id, customer_id) pair, the existing read_at is returned
// without creating a duplicate (unique index in Task 1 would also reject it,
// but the check-then-create pattern returns the original timestamp instead of
// throwing a conflict error).
//
// Auth + rate-limit middleware is registered in src/api/middlewares.ts.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const notificationId = req.params.id;

  // IDOR guard: retrieve the notification by id, then verify ownership.
  // Using retrieveNotification (by id) + manual receiver_id check prevents
  // the type error from FilterableNotificationProps lacking an `id` field,
  // while preserving the no-existence-leak guarantee (NOT_FOUND either way).
  const notif = req.scope.resolve<INotificationModuleService>(
    Modules.NOTIFICATION,
  );
  let owned: Awaited<ReturnType<typeof notif.retrieveNotification>> | null;
  try {
    owned = await notif.retrieveNotification(notificationId);
  } catch (err) {
    // Log unexpected infra errors (e.g. DB timeout) so operators can diagnose
    // them, while keeping fail-closed behavior (treat as not-found) intact.
    try {
      req.scope
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(
          `[store/notifications/:id/read] retrieveNotification(${notificationId}) failed — treating as not-found: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
    } catch {
      // logger not available in test container — silently ignore
    }
    owned = null;
  }
  // Fail-closed: treat wrong owner as not-found (no existence leak).
  if (!owned || owned.receiver_id !== customerId || owned.channel !== 'feed') {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'Notification not found',
    );
  }

  // Upsert: check-then-create to return the original read_at on a replay.
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [existing] = await packs.listNotificationReads(
    { notification_id: notificationId, customer_id: customerId },
    { take: 1 },
  );
  if (existing) {
    res.json({ id: notificationId, read_at: existing.read_at });
    return;
  }

  const now = new Date();
  try {
    await packs.createNotificationReads({
      notification_id: notificationId,
      customer_id: customerId,
      read_at: now,
    });
    res.json({ id: notificationId, read_at: now });
  } catch (err) {
    // TOCTOU race: a concurrent mark-read may have inserted between our check
    // above and the insert here.  Re-fetch; if the row now exists (race winner
    // committed first) return its read_at rather than surfacing a dup-key error.
    const [created] = await packs.listNotificationReads(
      { notification_id: notificationId, customer_id: customerId },
      { take: 1 },
    );
    if (created) {
      res.json({ id: notificationId, read_at: created.read_at });
      return;
    }
    throw err;
  }
}
