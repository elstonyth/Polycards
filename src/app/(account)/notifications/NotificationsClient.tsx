'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { relativeTime } from '@/lib/format';
import {
  getNotifications,
  markRead,
  markAllRead,
} from '@/lib/actions/notifications';
import type { Notification } from '@/lib/actions/notifications';
import { copyFor } from '@/lib/notifications/copy';
import { displayUnreadTotal } from '@/lib/notifications/unread-total';
import { rollbackRead } from '@/lib/notifications/rollback-read';

export default function NotificationsClient({
  initial,
  page = 1,
  unreadCount,
}: {
  initial: Notification[];
  page?: number;
  unreadCount: number;
}) {
  const [items, setItems] = useState<Notification[]>(initial);
  const [clearing, setClearing] = useState(false);
  // The cross-page total lives in state so Mark-all-read can zero it: the
  // `unreadCount` prop is frozen and can't observe the clear this button does
  // itself, which would otherwise leave a non-zero label after a full clear.
  const [serverTotal, setServerTotal] = useState(unreadCount);
  const unread = items.filter((n) => !n.readAt).length;
  // Unread on THIS page at first render — frozen (the component remounts per
  // page via key={res.page}), so it anchors how far local reads have drifted
  // the server total below.
  const initialUnreadOnPage = useMemo(
    () => initial.filter((n) => !n.readAt).length,
    [initial],
  );
  const totalUnread = displayUnreadTotal(
    serverTotal,
    initialUnreadOnPage,
    unread,
  );

  // The feed rows are LINKS: acting on one navigates away and unmounts this
  // page, so the optimistic state dies with the component. Coming back — via
  // the browser Back button in particular — the router can restore the RSC
  // payload rendered BEFORE the click, making `initial` a pre-click snapshot in
  // which the row is unread again. (`cache: 'no-store'` on the fetch does not
  // cover this: it governs the fetch, not the client router cache.)
  //
  // So re-sync from the server on mount, exactly as the header bell already
  // does for its badge — the reason the badge never went stale. Doing it here
  // rather than with revalidatePath() in the action is deliberate: a
  // revalidation dispatched from markRead races the in-flight Link navigation
  // and non-deterministically REPLACES the /notifications history entry, so
  // Back skips the feed entirely: measured with scripts/probe-notifications.mjs
  // + scripts/probe-notifications-history.mjs, 9 of 12 mark-read clicks lost the
  // entry with revalidatePath, 0 of 18 without it, and 0 of 8 for an already-read
  // row (a plain link firing no action). A mount-time re-sync races nothing.
  useEffect(() => {
    let live = true;
    void getNotifications(page)
      .then((r) => {
        if (live && r.ok) setItems(r.notifications);
      })
      // A transport failure (offline, a mid-deploy action-id mismatch) just
      // keeps the server-rendered `initial` list — same posture as the header
      // bell badge (NotificationBell.tsx).
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [page]);

  async function onRead(id: string) {
    // Optimistic — mark read locally immediately.
    setItems((xs) =>
      xs.map((n) =>
        n.id === id ? { ...n, readAt: new Date().toISOString() } : n,
      ),
    );
    try {
      const r = await markRead(id);
      if (!r.ok) setItems((xs) => rollbackRead(xs, [id]));
    } catch {
      setItems((xs) => rollbackRead(xs, [id]));
    }
  }

  async function onClearAll() {
    // Snapshot for rollback: only the rows this action actually flips.
    const wasUnread = items.filter((n) => !n.readAt).map((n) => n.id);
    // No early-return on an empty snapshot: the button only renders when the
    // cross-page total > 0, so reaching here with zero unread rows on THIS page
    // means unread lives on other pages — markAllRead() must still fire (it
    // clears every page server-side and is idempotent). With wasUnread empty,
    // the optimistic map and rollback are both no-ops, which is correct.
    setClearing(true);
    const now = new Date().toISOString();
    setItems((xs) => xs.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    try {
      const r = await markAllRead();
      if (r.ok) {
        // Clears every page server-side → the true total is now 0. Test:
        // displayUnreadTotal(0, 20, 20) === 0. On failure, leave serverTotal
        // alone; the row rollback below restores the old (still-correct) total.
        setServerTotal(0);
      } else {
        setItems((xs) => rollbackRead(xs, wasUnread));
      }
    } catch {
      setItems((xs) => rollbackRead(xs, wasUnread));
    } finally {
      setClearing(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-12 text-center">
        <Bell className="mx-auto h-8 w-8 text-white/25" aria-hidden />
        {page > 1 ? (
          <>
            <p className="mt-3 text-sm font-semibold text-white">
              Nothing on this page.
            </p>
            <p className="mt-1 text-[13px] text-white/50">
              You&rsquo;ve reached the end of your notifications.
            </p>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm font-semibold text-white">
              No notifications yet.
            </p>
            <p className="mt-1 text-[13px] text-white/50">
              VIP level-ups, unlocked commissions, and reward wins land here.{' '}
              <Link
                href="/"
                className="font-semibold text-white underline underline-offset-2 hover:text-white/80"
              >
                Rip a pack
              </Link>{' '}
              to get things moving.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      {/* unreadCount is the server's true cross-page total (route.ts contract);
          decremented locally as rows on this page get optimistically marked. */}
      {totalUnread > 0 && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => void onClearAll()}
            disabled={clearing}
            className="rounded-full border border-white/15 px-3 py-1.5 text-[12px] font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            {clearing ? 'Clearing…' : `Mark all read (${totalUnread})`}
          </button>
        </div>
      )}

      <ul className="mt-3 space-y-2">
        {items.map((n) => {
          const copy = copyFor(n.template);
          const Icon = copy.icon;
          const body = copy.body(n.data);
          const isUnread = !n.readAt;

          const inner = (
            <>
              <span
                aria-hidden
                className={
                  isUnread
                    ? 'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white'
                    : 'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.04] text-white/50'
                }
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white/90">
                  {copy.title}
                </p>
                {body && (
                  <p className="mt-0.5 text-[13px] leading-snug text-white/55">
                    {body}
                  </p>
                )}
                {copy.href && (
                  <span className="mt-1 inline-block text-[12px] font-semibold text-white/70">
                    {copy.action} →
                  </span>
                )}
              </div>
              <span className="shrink-0 whitespace-nowrap text-[11px] text-white/40">
                {relativeTime(n.createdAt)}
              </span>
            </>
          );

          // Hover response is split OUT of the base shell: a read row with no
          // href renders as a plain <div>, and a non-interactive element that
          // lights up under the cursor reads as clickable. Suspending the VIP
          // surfaces made that reachable — vip_level_up and voucher_claimed
          // are the first templates to carry href: null (spec 2026-07-29).
          const shell = isUnread
            ? 'flex w-full items-start gap-3 rounded-xl border border-white/25 bg-white/[0.06] p-3 text-left transition-colors'
            : 'flex w-full items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-left opacity-70 transition-colors';
          const interactive = isUnread
            ? 'hover:bg-white/10'
            : 'hover:opacity-100';

          return (
            <li key={n.id}>
              {copy.href ? (
                // Opening the destination is the read signal — a row you acted
                // on is a row you dealt with.
                <Link
                  href={copy.href}
                  onClick={() => {
                    if (isUnread) void onRead(n.id);
                  }}
                  className={`${shell} ${interactive}`}
                >
                  {inner}
                  {isUnread && <span className="sr-only">, unread</span>}
                </Link>
              ) : isUnread ? (
                <button
                  type="button"
                  onClick={() => void onRead(n.id)}
                  className={`${shell} ${interactive}`}
                >
                  {inner}
                  <span className="sr-only">, unread — mark as read</span>
                </button>
              ) : (
                <div className={shell}>{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
