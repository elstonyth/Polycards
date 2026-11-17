'use server';

/**
 * Wallet server action — reads the full credit balance + freeze/unlock state.
 *
 * Backend route: GET /store/credits
 * Wire shape: { wallet: { balance, available, is_frozen }, transactions: [...] }
 *
 * WalletEnvelopeSchema reads the nested `wallet` block out of that envelope,
 * so only the inner object is validated (not the transactions).
 */
import { store } from '@/lib/store';
import {
  actionFailure,
  COPY,
  UNAUTHORIZED,
  type ErrorRule,
} from '@/lib/errors';
import { WalletEnvelopeSchema } from '@/lib/data/schemas';

export type Wallet = {
  balance: number;
  available: number;
  isFrozen: boolean;
  /** Amount withdrawable now — 0 while the playthrough gate is closed. */
  withdrawable: number;
  /** Playthrough gate: deposits must be fully used on packs to unlock. */
  playthrough: { deposited: number; used: number; remaining: number };
  /** Bonus credit inside `balance` — spend only, never withdrawable (the
   *  backend already leaves it out of `withdrawable`). */
  bonus: number;
  /** At least one top-up ever — withdrawals and deliveries need it. */
  hasTopup: boolean;
};

export type WalletResult =
  | { ok: true; wallet: Wallet }
  | { ok: false; error: string; needsAuth?: boolean };

const LOGIN_REQUIRED = 'Please log in to view your wallet.';
// Only the 401 rule is this action's own: a rate limit gets the shared
// transport sentence from friendlyFailure (lib/errors.ts), which is what this
// table used to spell out for itself.
const WALLET_RULES: ErrorRule[] = [[UNAUTHORIZED, LOGIN_REQUIRED]];
const WALLET_FALLBACK = COPY.generic;

export async function getWallet(): Promise<WalletResult> {
  const r = await store.get('/store/credits', WalletEnvelopeSchema);
  if (!r.ok) {
    return actionFailure(r, {
      loggedOut: LOGIN_REQUIRED,
      rules: WALLET_RULES,
      fallback: WALLET_FALLBACK,
    });
  }
  const w = r.data.wallet;
  return {
    ok: true,
    wallet: {
      balance: w.balance,
      available: w.available,
      isFrozen: w.is_frozen,
      // Deploy-skew fallback: a backend missing these renders as
      // not-yet-withdrawable (0) rather than crashing the page. Default to 0
      // — never another balance field — so unknown never overstates.
      withdrawable: w.withdrawable ?? 0,
      playthrough: w.playthrough ?? { deposited: 0, used: 0, remaining: 0 },
      // An older backend has no bonus credit at all.
      bonus: w.bonus ?? 0,
      // An older backend has no top-up gate.
      hasTopup: w.has_topup ?? true,
    },
  };
}
