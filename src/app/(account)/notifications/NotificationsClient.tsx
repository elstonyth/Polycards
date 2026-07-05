'use client';

import { useState } from 'react';
import { relativeTime } from '@/lib/format';
import { markRead } from '@/lib/actions/notifications';
import type { Notification } from '@/lib/actions/notifications';

const TITLES: Record<string, string> = {
  vip_level_up: 'You leveled up!',
  commission_matured: 'Commission unlocked',
  reward_won: 'You won a reward!',
  voucher_claimed: 'Voucher redeemed',
};

export default function NotificationsClient({
  initial,
}: {
  initial: Notification[];
}) {
  const [items, setItems] = useState<Notification[]>(initial);

  async function onRead(id: string) {
    // Optimistic update — mark read locally immediately
    setItems((xs) =>
      xs.map((n) =>
        n.id === id ? { ...n, readAt: new Date().toISOString() } : n,
      ),
    );
    const r = await markRead(id);
    if (!r.ok) {
      // Revert on server failure
      setItems((xs) =>
        xs.map((n) => (n.id === id ? { ...n, readAt: null } : n)),
      );
    }
  }

  if (items.length === 0) {
    return <p className="mt-4 text-sm text-white/50">No notifications yet.</p>;
  }

  return (
    <ul className="mt-4 space-y-2">
      {items.map((n) => {
        const inner = (
          <>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white/90">
                {TITLES[n.template] ?? n.template}
              </p>
            </div>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-white/40">
              {relativeTime(n.createdAt)}
            </span>
          </>
        );
        return (
          <li key={n.id}>
            {n.readAt ? (
              <div className="flex w-full items-start justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 opacity-70">
                {inner}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void onRead(n.id)}
                className="flex w-full items-start justify-between gap-3 rounded-xl border border-buyback/30 bg-buyback/[0.06] p-3 text-left transition-colors hover:bg-buyback/10"
              >
                {inner}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
