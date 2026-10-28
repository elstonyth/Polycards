'use server';

import { store, type Failure } from '@/lib/store';
import { friendlyFailure, type ErrorRule } from '@/lib/errors';
import {
  CoinFlipHistorySchema,
  CoinFlipReceiptSchema,
  CoinFlipSettingsSchema,
  type CoinFlipFailure,
} from '@/lib/coin-flip';

const rules: readonly ErrorRule[] = [
  [/expired/i, 'Quote expired. Review your card again.'],
  [
    /changed/i,
    'Your card or coin flip settings changed. Review your card again.',
  ],
  [/paused|not configured/i, 'Coin flip is currently paused.'],
  [/maximum/i, 'This card exceeds the maximum coin flip value.'],
  [/still processing/i, 'Your card is still processing. Try again later.'],
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
function failure(f: Failure): CoinFlipFailure {
  return {
    ok: false,
    missing: f.status === 404,
    error: friendlyFailure(
      f,
      rules,
      'Could not confirm the flip. Check its status before trying again.',
    ),
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
    : failure(result);
}
export async function quoteCoinFlip(pullId: string) {
  const result = await store.post(
    '/store/coin-flips/quotes',
    CoinFlipReceiptSchema,
    { pull_id: pullId },
  );
  return result.ok ? { ok: true as const, ...result.data } : failure(result);
}
export async function acceptCoinFlip(id: string) {
  const result = await store.post(
    `/store/coin-flips/${encodeURIComponent(id)}/accept`,
    CoinFlipReceiptSchema,
    {},
  );
  return result.ok ? { ok: true as const, ...result.data } : failure(result);
}
export async function getCoinFlipRound(id: string) {
  const result = await store.get(
    `/store/coin-flips/${encodeURIComponent(id)}`,
    CoinFlipReceiptSchema,
  );
  return result.ok ? { ok: true as const, ...result.data } : failure(result);
}
export async function getCoinFlipHistory(page = 1) {
  const offset =
    (Math.max(1, Math.min(10000, Number.isSafeInteger(page) ? page : 1)) - 1) *
    10;
  const result = await store.get(
    `/store/coin-flips?limit=10&offset=${offset}`,
    CoinFlipHistorySchema,
  );
  return result.ok ? { ok: true as const, ...result.data } : failure(result);
}
