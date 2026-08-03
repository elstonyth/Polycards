'use client';

import { useEffect, useState } from 'react';
import type { PackDetail } from '@/lib/data/packs';

const POLL_MS = 60_000;

/** Live pack detail: fetches immediately on mount AND on every pack switch,
 *  then refreshes every 60s while the tab is visible. The caller only ever
 *  passes `initial` for the matching pack (null on a sibling switch, per
 *  PackDetailClient) -- so a switch renders null (the caller's gated-empty
 *  sections) until the immediate tick lands, never the PREVIOUS pack's pool/
 *  Top Hits/odds under the new pack's name. The immediate tick still matters:
 *  without it, a sibling switch would sit empty for up to a full poll
 *  interval instead of resolving within one request. */
export function usePackDetailPoll(
  slug: string,
  initial: PackDetail | null,
): PackDetail | null {
  const [detail, setDetail] = useState(initial);

  // Reset to the new seed only on a genuine pack switch — never on a
  // same-slug seed re-render, which would stomp fresher polled data.
  // "Adjust state when props change" pattern: setState during render of the
  // same component, per React docs; avoids the effect-cascade lint error.
  const [prevSlug, setPrevSlug] = useState(slug);
  if (prevSlug !== slug) {
    setPrevSlug(slug);
    setDetail(initial);
  }

  useEffect(() => {
    let active = true;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(
          `/api/pack-detail/${encodeURIComponent(slug)}`,
          {
            cache: 'no-store',
          },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { detail?: PackDetail };
        if (active && body.detail) setDetail(body.detail);
      } catch {
        // keep the last good detail
      }
    };
    void tick(); // correct the seed right away (effect re-runs per slug)
    const id = setInterval(tick, POLL_MS);
    // Refocusing a backgrounded tab refetches right away — interval ticks
    // skipped while hidden would otherwise leave stale prices for ≤60s.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [slug]);

  return detail;
}
