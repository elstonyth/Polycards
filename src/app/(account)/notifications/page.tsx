import type { Metadata } from 'next';
import { AccountHeader, Pager } from '@/components/account/ui';
import { getNotifications } from '@/lib/actions/notifications';
import NotificationsClient from './NotificationsClient';

export const metadata: Metadata = { title: 'Notifications' };

// Server-paged feed (?page=N → backend limit/offset). The client island only
// handles optimistic mark-read; paging is plain links, no client JS.
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageRaw } = await searchParams;
  const page = Number(pageRaw);
  const res = await getNotifications(Number.isInteger(page) ? page : 1);

  return (
    <>
      <AccountHeader
        title="Notifications"
        sub={
          res.ok && res.unreadCount > 0
            ? `${res.unreadCount} unread — tap a notification to mark it read.`
            : 'Your VIP and commission updates.'
        }
      />
      {res.ok ? (
        <>
          {/* key: remount on page change — the client island seeds its state
              from `initial` once, so a same-route ?page= navigation would
              otherwise keep showing the previous page's rows. */}
          <NotificationsClient
            key={res.page}
            initial={res.notifications}
            page={res.page}
          />
          <Pager
            page={res.page}
            hasMore={res.hasMore}
            basePath="/notifications"
          />
        </>
      ) : (
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
          {res.error}
        </p>
      )}
    </>
  );
}
