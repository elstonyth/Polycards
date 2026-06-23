import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { INotificationModuleService } from '@medusajs/framework/types';

// GET /store/notifications — the authenticated customer's own in-app feed.
//
// Owner-scoping: receiver_id is derived ONLY from the verified bearer token
// (req.auth_context.actor_id). It is NEVER read from the query string or body,
// so one customer cannot list another customer's notifications (IDOR prevention).
//
// Auth + rate-limit middleware is registered in src/api/middlewares.ts.
// This route is read-only; mark-read (write) is deferred to Phase 5.
//
// read_at: the base Notification Module does not track read state (Phase 5);
// it is returned as null for all rows until mark-read is implemented.
// Most-recent feed page size (mirrors RECENT_TRANSACTIONS in store/credits).
const RECENT_NOTIFICATIONS = 50;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const receiverId = req.auth_context.actor_id;

  const notif = req.scope.resolve<INotificationModuleService>(
    Modules.NOTIFICATION,
  );

  const notifications = await notif.listNotifications(
    { receiver_id: receiverId, channel: 'feed' },
    { take: RECENT_NOTIFICATIONS, order: { created_at: 'DESC' } },
  );

  res.json({
    notifications: notifications.map((n) => ({
      id: n.id,
      template: n.template,
      data: n.data,
      created_at: n.created_at,
      // read_at is not tracked by the base Notification Module (Phase 5).
      read_at: null,
    })),
  });
}
