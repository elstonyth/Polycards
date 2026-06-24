'use server';

/**
 * Wallet server action — reads the full credit balance + freeze/unlock state.
 *
 * Backend route: GET /store/credits
 * Wire shape (flat, no nested `wallet` key):
 *   { balance, topup_total, spend_total, transactions: [...] }
 *
 * The brief described a `wallet` block — the REAL route emits all fields at the
 * top level alongside `transactions`. We read the root object directly.
 *
 * `is_frozen` and `next_unlock` are Phase 5+ extensions not yet emitted by the
 * credits route; they are optional in WalletSchema and default to safe values.
 * `available` (balance minus locked) is not a backend field either — we derive
 * it here as `balance − locked` (both default to 0 when absent).
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { friendlyError, isAuthError, type ErrorRule } from '@/lib/errors';
import { parseOne, WalletSchema } from '@/lib/data/schemas';

export type Wallet = {
  balance: number;
  available: number;
  locked: number;
  isFrozen: boolean;
  nextUnlock: { amount: number; date: string } | null;
};

export type WalletResult =
  | { ok: true; wallet: Wallet }
  | { ok: false; error: string; needsAuth?: boolean };

const WALLET_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — give it a moment and try again.',
  ],
  [/unauthorized|not authenticated|401/i, 'Please log in to view your wallet.'],
];
const WALLET_FALLBACK = 'Something went wrong. Please try again.';

export async function getWallet(): Promise<WalletResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to view your wallet.',
      needsAuth: true,
    };
  }

  try {
    const raw = await sdk.client.fetch('/store/credits', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });

    // The credits route returns fields at the root level (no nested `wallet` key).
    const w = parseOne(WalletSchema, raw);
    if (!w) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }

    const locked = 0; // not yet emitted by the credits route
    return {
      ok: true,
      wallet: {
        balance: w.balance,
        available: w.balance - locked,
        locked,
        isFrozen: w.is_frozen ?? false,
        nextUnlock: w.next_unlock
          ? { amount: w.next_unlock.amount, date: w.next_unlock.date }
          : null,
      },
    };
  } catch (error) {
    logger.error('[wallet] load failed:', error);
    return {
      ok: false,
      error: friendlyError(error, WALLET_RULES, WALLET_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}
