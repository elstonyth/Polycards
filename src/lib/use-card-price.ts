'use client';

import { useEffect, useState } from 'react';
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
  // never on a same-handle seed re-render, which would stomp fresher polled
  // data. "Adjust state when props change" pattern: setState during render of
  // the same component, per React docs; avoids the effect-cascade lint error.
  const [prevHandle, setPrevHandle] = useState(handle);
  if (prevHandle !== handle) {
    setPrevHandle(handle);
    setData(initial);
  }

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
    // Refocusing a backgrounded tab refetches right away — interval ticks
    // skipped while hidden would otherwise leave a stale price for ≤60s.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [handle]);

  return data;
}
