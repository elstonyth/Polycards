'use server';

/**
 * Wallet server action — reads the full credit balance + freeze/unlock state.
 *
 * Backend route: GET /store/credits
 * Wire shape: { wallet: { balance, available, locked, is_frozen, next_unlock }, transactions: [...] }
 *
 * The nested `wallet` block is extracted before parsing so WalletSchema only
 * needs to validate the inner object (not the outer envelope).
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
  /** Amount withdrawable now — 0 while the playthrough gate is closed. */
  withdrawable: number;
  /** Playthrough gate: deposits must be fully used on packs to unlock. */
  playthrough: { deposited: number; used: number; remaining: number };
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

    // Extract the nested wallet block then validate it.
    const w = parseOne(WalletSchema, (raw as { wallet?: unknown }).wallet);
    if (!w) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }

    return {
      ok: true,
      wallet: {
        balance: w.balance,
        available: w.available,
        locked: w.locked,
        isFrozen: w.is_frozen,
        nextUnlock: w.next_unlock
          ? { amount: w.next_unlock.amount, date: w.next_unlock.date }
          : null,
        withdrawable: w.withdrawable,
        playthrough: {
          deposited: w.playthrough.deposited,
          used: w.playthrough.used,
          remaining: w.playthrough.remaining,
        },
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
