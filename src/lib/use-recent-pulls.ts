'use client';

import { useEffect, useRef, useState } from 'react';
import type { RecentPull } from '@/lib/data/packs';

// "Live" = fast polling of the same-origin proxy (a direct :9000 call is
// CORS-blocked). 4s keeps any pull visible to everyone within seconds without
// websocket infrastructure — revisit only if traffic makes polling hurt.
const POLL_MS = 4000;

/** Live recent-pulls feed: seeds from the server snapshot, then polls.
 *  `packSlug` scopes the poll to one pack's own history (the /slots/[slug]
 *  pages); omit it for the global feed.
 *  Keeps the last good set on transient failures so the feed never blanks. */
export function useLiveRecentPulls(
  initial: RecentPull[],
  packSlug?: string,
): RecentPull[] {
  const [pulls, setPulls] = useState<RecentPull[]>(initial);
  // Which pack the rows on screen belong to (the seed came from the server for
  // the mount-time pack). An empty response only replaces them when the pack
  // changed — otherwise a pack with no pulls would keep showing the previous
  // pack's rows, while a backend blip would blank a healthy feed.
  const shownFor = useRef(packSlug);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      // Hidden/background tabs poll forever otherwise — skip while not visible
      // (mirrors usePackDetailPoll / useCardPrice); the 5s backend cache means
      // even visible tabs collapse to one compute per window.
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(
          packSlug
            ? `/api/recent-pulls?pack_id=${encodeURIComponent(packSlug)}`
            : '/api/recent-pulls',
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { pulls?: RecentPull[] };
        if (active && Array.isArray(data.pulls)) {
          if (data.pulls.length > 0 || shownFor.current !== packSlug) {
            setPulls(data.pulls);
            shownFor.current = packSlug;
          }
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
    // packSlug in deps: a client-side nav between two pack pages would otherwise
    // keep polling the pack the component first mounted with.
  }, [packSlug]);

  return pulls;
}
