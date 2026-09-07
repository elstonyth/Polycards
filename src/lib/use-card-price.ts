'use client';

import type { CardDetailData } from '@/lib/data/cards';
import { CardPollResponseSchema, parseOne } from '@/lib/data/schemas';
import { useLivePoll } from '@/lib/use-live-poll';

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
  const { data, pending } = useLivePoll<CardDetailData | null>(
    handle ? `/api/cards/${encodeURIComponent(handle)}` : null,
    initial,
    {
      intervalMs: POLL_MS,
      resetKey: handle ?? '',
      accept: (next) => parseOne(CardPollResponseSchema, next)?.card ?? null,
    },
  );
  // `pending` is exactly "this handle's data hasn't landed yet" (a genuine
  // card switch on an overlay reuse): show the new seed, never the previous
  // card. A same-handle seed re-render is not pending, so it can never stomp
  // fresher polled data.
  return pending ? initial : data;
}
