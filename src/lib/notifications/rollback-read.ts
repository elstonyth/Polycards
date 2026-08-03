import type { Notification } from '@/lib/actions/notifications';

// Reverts the optimistic "read" flip for the given notification ids back to
// unread. Shared by NotificationsClient's onRead (single id) and onClearAll
// (the wasUnread snapshot) — both mark rows read optimistically before the
// server action resolves, and both need the exact same undo when the call
// returns `!ok` OR throws (a server-action transport failure, e.g. offline
// or a deploy rotating action ids under an open tab).
export function rollbackRead(
  items: Notification[],
  ids: Iterable<string>,
): Notification[] {
  const revert = ids instanceof Set ? ids : new Set(ids);
  return items.map((n) => (revert.has(n.id) ? { ...n, readAt: null } : n));
}
