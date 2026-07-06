'use client';

import { useEffect, useRef, useState } from 'react';
import type { PackDetail } from '@/lib/data/packs';

const POLL_MS = 60_000;

/** Refreshes the whole pack grid's prices in one request every 60s while the
 *  tab is visible (same seed-then-poll contract as useLiveRecentPulls). */
export function usePackDetailPoll(
  slug: string,
  initial: PackDetail | null,
): PackDetail | null {
  const [detail, setDetail] = useState(initial);

  // Reset to the new seed only on a genuine pack switch — never on a
  // same-slug seed re-render, which would stomp fresher polled data.
  const prevSlug = useRef(slug);
  useEffect(() => {
    if (prevSlug.current !== slug) {
      prevSlug.current = slug;
      setDetail(initial);
    }
  }, [slug, initial]);

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
    const id = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [slug]);

  return detail;
}
