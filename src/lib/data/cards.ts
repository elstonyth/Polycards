/**
 * Single-card detail seam (GET /store/cards/:handle) — powers the /card/[handle]
 * server page and (via the /api/cards proxy) the overlay's 60s price refresh.
 * Unknown handle ⇒ 'notfound' (page 404s); backend down ⇒ 'error' (page shows a
 * retry state; the overlay proxy keeps its grid data).
 */
import { store } from '@/lib/store';
import { CardDetailEnvelopeSchema } from '@/lib/data/schemas';
import { toCardView, type CardView } from '@/lib/card-view';

export interface CardPricePoint {
  date: string;
  valueMyr: number;
}

/** The card page's payload: the card view plus what only this route sends.
 *  `priceMyr` narrows to a NUMBER — CardDetailSchema requires a finite
 *  marketPriceMyr, so a detail is never unpriced. */
export type CardDetailData = CardView & {
  set: string;
  grader: string;
  grade: string;
  priceMyr: number;
  pcSyncedAt: string | null;
  priceHistory: CardPricePoint[];
};

/** Why a card lookup produced no card — a genuine miss (404) must 404, but a
 *  transient backend failure must NOT: a customer opening a bookmarked card
 *  they own would be told it does not exist. Mirrors getPublicProfile. */
export type CardResult =
  | { status: 'ok'; card: CardDetailData }
  | { status: 'notfound' }
  | { status: 'error' };

export async function getCardResult(handle: string): Promise<CardResult> {
  // Public route: no bearer, and `cache: 'auto'` (no cache key on the wire)
  // exactly as the bare sdk.client.fetch sent — an explicit no-store would
  // make any statically prerenderable caller dynamic.
  const r = await store.get(
    `/store/cards/${encodeURIComponent(handle)}`,
    CardDetailEnvelopeSchema,
    { auth: 'none', cache: 'auto' },
  );
  // Everything that is not a genuine 404 — 5xx, a network drop, a 200 whose
  // body doesn't validate — is a backend/contract fault, and must surface as
  // an error rather than a fabricated "does not exist". The port already
  // logged it, with the handle in the path.
  if (!r.ok) {
    return r.kind === 'not_found'
      ? { status: 'notfound' }
      : { status: 'error' };
  }
  const card = r.data.card;
  return {
    status: 'ok',
    card: {
      ...toCardView(card),
      set: card.set,
      grader: card.grader,
      grade: card.grade,
      priceMyr: card.marketPriceMyr,
      pcSyncedAt: card.pcSyncedAt,
      priceHistory: card.priceHistory,
    },
  };
}

/** Null-returning view of {@link getCardResult}, kept for callers that only
 *  need "card or nothing" (the /api/cards poll proxy). */
export async function getCard(handle: string): Promise<CardDetailData | null> {
  const result = await getCardResult(handle);
  return result.status === 'ok' ? result.card : null;
}
