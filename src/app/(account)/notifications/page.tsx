import type { Metadata } from 'next';
import { AccountHeader } from '@/components/account/ui';
import { getNotifications } from '@/lib/actions/notifications';
import NotificationsClient from './NotificationsClient';

export const metadata: Metadata = { title: 'Notifications' };

export default async function NotificationsPage() {
  const res = await getNotifications();
  return (
    <>
      <AccountHeader
        title="Notifications"
        sub="Your VIP and commission updates."
      />
      {res.ok ? (
        <NotificationsClient initial={res.notifications} />
      ) : (
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
          {res.error}
        </p>
      )}
    </>
  );
}
