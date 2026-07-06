'use client';

import { useEffect, useRef, useState } from 'react';
import type { CardDetailData } from '@/lib/data/cards';

// Prices move at most daily (nightly PriceCharting sync) plus FX/markup edits;
// 60s keeps a long-lived tab honest without hammering the proxy.
const POLL_MS = 60_000;

/** Live card detail: seeds from server/grid data, refetches every 60s while
 *  the document is visible. Failures keep the last good data (never blanks);
 *  `handle: null` disables fetching entirely (closed overlay). */
export function useCardPrice(
  handle: string | null,
  initial: CardDetailData | null,
): CardDetailData | null {
  const [data, setData] = useState(initial);

  // Reset to the new seed only on a genuine card switch (overlay reuse) —
  // never on a same-handle seed re-render, which would stomp fresher polled data.
  const prevHandle = useRef(handle);
  useEffect(() => {
    if (prevHandle.current !== handle) {
      prevHandle.current = handle;
      setData(initial);
    }
  }, [handle, initial]);

  useEffect(() => {
    if (!handle) return;
    let active = true;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/api/cards/${encodeURIComponent(handle)}`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const body = (await res.json()) as { card?: CardDetailData };
        if (active && body.card) setData(body.card);
      } catch {
        // keep the last good data on a transient failure
      }
    };
    void tick(); // hydrate grid-seeded overlays immediately
    const id = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [handle]);

  return data;
}
