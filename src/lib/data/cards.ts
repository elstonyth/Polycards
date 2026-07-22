/**
 * Single-card detail seam (GET /store/cards/:handle) — powers the /card/[handle]
 * server page and (via the /api/cards proxy) the overlay's 60s price refresh.
 * Unknown handle ⇒ 'notfound' (page 404s); backend down ⇒ 'error' (page shows a
 * retry state; the overlay proxy keeps its grid data).
 */
import { FetchError } from '@medusajs/js-sdk';
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { CardDetailSchema, parseOne } from '@/lib/data/schemas';
import type { Rarity } from '@/lib/packs-data';

export interface CardPricePoint {
  date: string;
  valueMyr: number;
}

export interface CardDetailData {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  image: string;
  slab_image: string | null;
  marketPriceMyr: number;
  rarity: Rarity | null;
  pcSyncedAt: string | null;
  priceHistory: CardPricePoint[];
}

/** Why a card lookup produced no card — a genuine miss (404) must 404, but a
 *  transient backend failure must NOT: a customer opening a bookmarked card
 *  they own would be told it does not exist. Mirrors getPublicProfile. */
export type CardResult =
  | { status: 'ok'; card: CardDetailData }
  | { status: 'notfound' }
  | { status: 'error' };

export async function getCardResult(handle: string): Promise<CardResult> {
  try {
    const { card } = await sdk.client.fetch<{ card: unknown }>(
      `/store/cards/${encodeURIComponent(handle)}`,
    );
    const valid = parseOne(CardDetailSchema, card) as CardDetailData | null;
    // A 200 whose body doesn't validate is a backend/contract fault, not a
    // missing card — surface it as an error rather than a fabricated 404.
    if (!valid) {
      logger.error(`[cards] schema validation failed for '${handle}'`);
      return { status: 'error' };
    }
    return { status: 'ok', card: valid };
  } catch (error) {
    if (error instanceof FetchError && error.status === 404) {
      return { status: 'notfound' };
    }
    logger.error(`[cards] failed to load card '${handle}':`, error);
    return { status: 'error' };
  }
}

/** Null-returning view of {@link getCardResult}, kept for callers that only
 *  need "card or nothing" (the /api/cards poll proxy). */
export async function getCard(handle: string): Promise<CardDetailData | null> {
  const result = await getCardResult(handle);
  return result.status === 'ok' ? result.card : null;
}
