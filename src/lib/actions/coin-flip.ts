'use server';

import { store, type Failure } from '@/lib/store';
import { friendlyFailure, type ErrorRule } from '@/lib/errors';
import {
  CoinFlipFeedSchema,
  CoinFlipHistorySchema,
  CoinFlipReceiptSchema,
  CoinFlipSettingsSchema,
  type CoinFlipFailure,
  type CoinFlipHistoryFilter,
  type CoinSide,
} from '@/lib/coin-flip';

const rules: readonly ErrorRule[] = [
  // First: it names the card, and a card's name must not trip the rules below.
  [/is still processing\./i, (text) => text],
  [/enough tickets/i, 'You no longer have that many tickets.'],
  [
    /no longer available|invalid card value/i,
    'A card in this flip is no longer available. Choose your cards again.',
  ],
  [/unlock selling/i, 'Pay for one pack yourself before flipping this card.'],
  [/expired.*tickets/i, 'Quote expired. Review your tickets again.'],
  [
    /tickets.*changed/i,
    'Your tickets or coin flip settings changed. Review your tickets again.',
  ],
  [/expired/i, 'Quote expired. Review your flip again.'],
  [
    /changed/i,
    'Your cards or coin flip settings changed. Review your flip again.',
  ],
  [/paused|not configured/i, 'Coin flip is currently paused.'],
  [/playthrough/i, 'Complete your deposit playthrough before flipping a card.'],
  [
    /top.up|deposit/i,
    'Complete a top-up and its playthrough before flipping a card.',
  ],
  [/phone/i, 'Verify your phone number before flipping a card.'],
  [
    /not available|under review|unavailable/i,
    'Coin flips are unavailable for this account or card.',
  ],
  [/not found/i, 'This flip or card could not be found.'],
];
function failure(f: Failure, fallback: string): CoinFlipFailure {
  return {
    ok: false,
    missing: f.status === 404,
    error: friendlyFailure(f, rules, fallback),
    // A valid refusal is final; timeouts, proxy errors and malformed success are not.
    uncertain:
      f.kind === 'invalid_shape' ||
      !f.status ||
      f.status >= 500 ||
      [401, 408, 429].includes(f.status),
  };
}
export async function getCoinFlipSettings() {
  const result = await store.get(
    '/store/coin-flips/settings',
    CoinFlipSettingsSchema,
  );
  return result.ok
    ? { ok: true as const, settings: result.data }
    : failure(
        result,
        'Could not load coin flip. Refresh the page to try again.',
      );
}
export async function quoteCoinFlip(
  pullIds: string[],
  chosenSide: CoinSide,
  tickets = 0,
) {
  const result = await store.post(
    '/store/coin-flips/quotes',
    CoinFlipReceiptSchema,
    {
      ...(pullIds.length ? { pull_ids: pullIds } : {}),
      ...(tickets > 0 ? { tickets } : {}),
      chosen_side: chosenSide,
    },
  );
  return result.ok
    ? { ok: true as const, ...result.data }
    : failure(result, 'Could not load a quote. Nothing has been staked.');
}
export async function acceptCoinFlip(id: string) {
  const result = await store.post(
    `/store/coin-flips/${encodeURIComponent(id)}/accept`,
    CoinFlipReceiptSchema,
    {},
  );
  return result.ok
    ? { ok: true as const, ...result.data }
    : failure(
        result,
        'Could not confirm the flip. Check its status before trying again.',
      );
}
export async function getCoinFlipFeed(filter: CoinFlipHistoryFilter = 'all') {
  const status =
    filter === 'won' || filter === 'lost' ? `?status=${filter}` : '';
  const result = await store.get(
    `/store/coin-flips/recent${status}`,
    CoinFlipFeedSchema,
  );
  return result.ok
    ? { ok: true as const, ...result.data }
    : failure(result, 'Could not load flips. Try again.');
}
export async function getCoinFlipRound(id: string) {
  const result = await store.get(
    `/store/coin-flips/${encodeURIComponent(id)}`,
    CoinFlipReceiptSchema,
  );
  return result.ok
    ? { ok: true as const, ...result.data }
    : failure(result, 'Could not read this flip. Check it again.');
}
export async function getCoinFlipHistory(
  page = 1,
  filter: CoinFlipHistoryFilter = 'all',
) {
  const offset =
    (Math.max(1, Math.min(10000, Number.isSafeInteger(page) ? page : 1)) - 1) *
    10;
  const status =
    filter === 'won' || filter === 'lost' ? `&status=${filter}` : '';
  const result = await store.get(
    `/store/coin-flips?limit=10&offset=${offset}${status}`,
    CoinFlipHistorySchema,
  );
  return result.ok
    ? { ok: true as const, ...result.data }
    : failure(result, 'Could not load your flips. Try again.');
}
