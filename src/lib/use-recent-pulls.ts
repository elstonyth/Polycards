'use client';

import { useEffect, useRef, useState } from 'react';
import type { RecentFeed } from '@/lib/data/packs';
import type { Rarity } from '@/lib/packs-data';

// "Live" = polling of the same-origin proxy (a direct :9000 call is
// CORS-blocked). This is the storefront's single highest-volume request: one
// tick per open tab on the home or a pack page, forever. At 4s, 2000 concurrent
// tabs meant 500 req/s against a one-vCPU instance; 10s is the same feed at a
// fifth of the cost.
//
// Nothing perceptible is lost. Both hops already serve from 5s caches (this
// route and the backend's store/pulls/recent), so a row could already be ~10s
// behind the ledger, and the feed labels time in whole minutes.
const POLL_MS = 10_000;

/** Live pull-history feed: seeds from the server snapshot, then polls.
 *  `packSlug` scopes the poll to one pack's own history (the /slots/[slug]
 *  pages); omit it for the global feed. `rarity` keeps only that tier (the
 *  panel's tabs) — switching it refetches at once, and `pending` is true
 *  until rows for the new scope have landed (the previous scope's rows stay
 *  on screen meanwhile, so a tab switch never flashes an empty list).
 *  Keeps the last good set on transient failures so the feed never blanks. */
export function useLiveRecentPulls(
  initial: RecentFeed,
  packSlug?: string,
  rarity?: Rarity | null,
): RecentFeed & { pending: boolean } {
  const scope = `${packSlug ?? ''}|${rarity ?? ''}`;
  const [feed, setFeed] = useState<RecentFeed>(initial);
  // Which (pack, tier) the rows on screen belong to (the seed came from the
  // server for the mount-time pack, unfiltered). An empty response only
  // replaces them when the scope changed — otherwise a pack with no pulls
  // would keep showing the previous pack's rows, while a backend blip would
  // blank a healthy feed. The ref is what the async tick reads; the state
  // mirror is what `pending` renders from.
  const shownRef = useRef(scope);
  const [shownScope, setShownScope] = useState(scope);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      // Hidden/background tabs poll forever otherwise — skip while not visible
      // (mirrors usePackDetailPoll / useCardPrice); the 5s caches on both hops
      // mean even visible tabs collapse to one compute per window.
      if (document.visibilityState !== 'visible') return;
      try {
        const q = new URLSearchParams();
        if (packSlug) q.set('pack_id', packSlug);
        if (rarity) q.set('rarity', rarity);
        const qs = q.toString();
        const res = await fetch(`/api/recent-pulls${qs ? `?${qs}` : ''}`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = (await res.json()) as Partial<RecentFeed>;
        if (!active || !Array.isArray(data.pulls)) return;
        if (data.pulls.length > 0 || shownRef.current !== scope) {
          shownRef.current = scope;
          setShownScope(scope);
          setFeed({ pulls: data.pulls, drought: data.drought ?? {} });
        }
      } catch {
        // keep the current set on a transient failure
      }
    };
    void tick(); // swap in live data immediately, then keep polling
    const id = setInterval(tick, POLL_MS);
    // Refocusing a backgrounded tab refetches right away — ticks skipped while
    // hidden would otherwise leave the feed stale until the next interval.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // packSlug/rarity in deps: a client-side nav between two pack pages (or a
    // tab switch) would otherwise keep polling the scope the component first
    // mounted with.
  }, [packSlug, rarity, scope]);

  return { ...feed, pending: shownScope !== scope };
}
