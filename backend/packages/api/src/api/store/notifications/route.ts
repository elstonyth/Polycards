import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { INotificationModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { parsePaginationParams } from '../../../utils/pagination';

// GET /store/notifications — the authenticated customer's own in-app feed.
//
// Owner-scoping: receiver_id is derived ONLY from the verified bearer token
// (req.auth_context.actor_id). It is NEVER read from the query string or body,
// so one customer cannot list another customer's notifications (IDOR prevention).
//
// Auth + rate-limit middleware is registered in src/api/middlewares.ts.
//
// read_at: sourced from the notification_read packs side-table (Task 1).
// Rows that have no entry in that table are returned with read_at: null.
//
// unread_count: TRUE unread total across ALL the customer's feed notifications
// (not page-scoped): total feed rows minus notification_read rows with a
// read_at, both counted server-side. The nav badge and the /notifications
// header rely on this spanning beyond the returned page.
//
// Pagination: ?limit=&offset= (parsePaginationParams — shared with the admin
// audit/commissions routes). take limit + 1 → `has_more` without a separate
// count query; the extra row is sliced off before mapping.
const PAGE_SIZE = 20;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const receiverId = req.auth_context.actor_id;
  const { limit, offset } = parsePaginationParams(req.query, {
    defaultLimit: PAGE_SIZE,
    maxLimit: 50,
  });

  const notif = req.scope.resolve<INotificationModuleService>(
    Modules.NOTIFICATION,
  );

  // listAndCount: the count is the TOTAL matching feed rows (independent of
  // take/skip), which the true unread_count needs anyway — no extra query.
  const [rows, totalFeed] = await notif.listAndCountNotifications(
    { receiver_id: receiverId, channel: 'feed' },
    // id tiebreaker: batch creates land sibling rows in the same instant, and
    // created_at alone gives no stable order across offset pages.
    { take: limit + 1, skip: offset, order: { created_at: 'DESC', id: 'DESC' } },
  );
  const hasMore = rows.length > limit;
  const notifications = rows.slice(0, limit);

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // True unread total: all feed rows minus the customer's marked-read rows.
  // Reads are only ever created by the owner-scoped mark-read route against
  // feed notifications, so the subtraction is exact; clamp guards pathology
  // (e.g. a read row surviving its notification).
  const [, readCount] = await packs.listAndCountNotificationReads(
    { customer_id: receiverId, read_at: { $ne: null } },
    { take: 1 },
  );
  const unreadCount = Math.max(0, totalFeed - readCount);

  // Batch-fetch read state for this page from the packs side-table.
  const notifIds = notifications.map((n) => n.id);
  const reads =
    notifIds.length > 0
      ? await packs.listNotificationReads(
          { customer_id: receiverId, notification_id: notifIds },
          { take: notifIds.length },
        )
      : [];
  const readAtById = new Map(
    reads.map((r: { notification_id: string; read_at: Date | null }) => [
      r.notification_id,
      r.read_at,
    ]),
  );

  const mapped = notifications.map((n) => ({
    id: n.id,
    template: n.template,
    data: n.data,
    created_at: n.created_at,
    read_at: readAtById.get(n.id) ?? null,
  }));

  res.json({
    notifications: mapped,
    unread_count: unreadCount,
    has_more: hasMore,
  });
}
