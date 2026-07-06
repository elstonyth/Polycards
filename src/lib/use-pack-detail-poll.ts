'use client';

import { useEffect, useState } from 'react';
import type { PackDetail } from '@/lib/data/packs';

const POLL_MS = 60_000;

/** Refreshes the whole pack grid's prices in one request every 60s while the
 *  tab is visible (same seed-then-poll contract as useLiveRecentPulls). */
export function usePackDetailPoll(
  slug: string,
  initial: PackDetail | null,
): PackDetail | null {
  const [detail, setDetail] = useState(initial);

  useEffect(() => {
    setDetail(initial);
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
