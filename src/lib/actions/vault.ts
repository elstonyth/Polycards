'use server';

/**
 * Vault + credit server actions. Run server-side so the customer JWT stays in
 * the httpOnly cookie and the backend calls aren't CORS-blocked. The backend
 * derives the customer id from the bearer token alone — these actions never
 * send an id — so one customer can never touch another's vault or balance.
 *
 * Backend routes (all customer-authenticated):
 *   GET  /store/vault              — vaulted pulls + live buyback offers
 *   POST /store/vault/:id/buyback  — instant sell-back (credits FMV × pack %)
 *   GET  /store/credits            — balance (Σ ledger) + recent transactions
 *   POST /store/credits/topup      — buy credit via the mock gateway (demo)
 */
import { authedFetch } from '@/lib/authed-fetch';
import { logger } from '@/lib/logger';
import { sanePage } from '@/lib/page-param';
import { elapsedLabel } from '@/lib/transactions';
import { getAuthToken } from '@/lib/data/customer';
import { friendlyError, isAuthError } from '@/lib/errors';
import { VAULT_RULES, VAULT_FALLBACK } from '@/lib/vault-errors';
import {
  DEFAULT_DEPOSIT_METHOD,
  DEPOSIT_METHODS,
  enabledDepositMethods,
  isDepositMethod,
  type DepositMethodCode,
} from '@/lib/deposit-methods';
import {
  parseList,
  parseOne,
  VaultItemSchema,
  VaultShowcaseSchema,
  BalanceSchema,
  LatestEventSchema,
  AmountBalanceSchema,
  BuybackResultSchema,
  DepositStartSchema,
  PendingDepositSchema,
  WithdrawStartSchema,
  WithdrawBanksSchema,
  SavedBankAccountsSchema,
  CreditsSchema,
  CreditTransactionSchema,
  PaymentConfigSchema,
} from '@/lib/data/schemas';
import { mapVaultItem, type BackendVaultItem } from './vault-map';
export type { VaultItem } from './vault-map';

import type { VaultItem } from './vault-map';

export type VaultResult =
  | { ok: true; items: VaultItem[]; balance: number }
  | { ok: false; error: string; needsAuth?: boolean };

export type SellBackResult =
  | { ok: true; amount: number; percent: number; balance: number }
  | { ok: false; error: string; needsAuth?: boolean };

// Patterns live in lib/vault-errors.ts — a 'use server' file may only export
// async functions, so keeping them here made the ordering contract untestable
// (see the header there, and __tests__/vault-errors.test.ts).

// The vault list + the credit balance in one call (the page shows both).
export async function getVault(): Promise<VaultResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to view your vault.',
      needsAuth: true,
    };
  }

  try {
    const [vaultRes, creditRes] = await Promise.all([
      authedFetch(token, '/store/vault'),
      authedFetch(token, '/store/credits/balance'),
    ]);

    // The assertion widens the parse output to the fields the mapper also
    // READS but the schema deliberately does NOT guard (rolled_at, pack_title,
    // card.image/rarity/market_value, …). They ride the `looseObject` typed
    // `unknown`, so this is the seam where guarded and merely-carried fields
    // meet. Tightening VaultItemSchema to erase it would make a stale field
    // drop the row — i.e. delete a card from the customer's own vault.
    const items = (
      parseList(
        VaultItemSchema,
        (vaultRes as { items?: unknown }).items,
      ) as unknown as BackendVaultItem[]
    ).map(mapVaultItem);
    const credit = parseOne(BalanceSchema, creditRes);

    return { ok: true, items, balance: credit ? credit.balance : 0 };
  } catch (error) {
    logger.error('[vault] load failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// The bare credit balance — for surfaces that show affordability (the pack
// detail page) without paying for the full vault read. Null = not logged in
// or the read failed; callers render nothing rather than a wrong $0.
export async function getCreditBalance(): Promise<number | null> {
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const credit = parseOne(
      BalanceSchema,
      await authedFetch(token, '/store/credits/balance'),
    );
    return credit ? credit.balance : null;
  } catch (error) {
    logger.error('[vault] balance read failed:', error);
    return null;
  }
}

// The newest vault-visible event for the caller — the Vault tab's unread-dot
// signal. Deliberately not folded into getVault(): the dot is read from every
// page, and must not pay for a 500-item vault list. Null = logged out, empty
// vault, or a failed read; callers render no dot rather than a wrong one.
export async function getVaultLatest(): Promise<string | null> {
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const parsed = parseOne(
      LatestEventSchema,
      await authedFetch(token, '/store/vault/latest'),
    );
    return parsed?.latest_event_at ?? null;
  } catch (error) {
    logger.error('[vault] latest-event read failed:', error);
    return null;
  }
}

// The newest balance movement for the caller — the Me tab's money-dot signal.
// Every ledger row counts (sell-back, top-up, withdrawal, reward,
// pack-open charge): the row IS what the customer opens /transactions to read,
// so filtering to money-in would drop the debits people most want to verify.
// Null = logged out, no transactions, or a failed read; callers render no dot
// rather than a wrong one.
export async function getCreditsLatest(): Promise<string | null> {
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const parsed = parseOne(
      LatestEventSchema,
      await authedFetch(token, '/store/credits/latest'),
    );
    return parsed?.latest_event_at ?? null;
  } catch (error) {
    logger.error('[credits] latest-event read failed:', error);
    return null;
  }
}

export type TopUpActionResult =
  | {
      ok: true;
      amount: number;
      balance: number;
      /** True when the backend deduped a replayed Idempotency-Key — the
       *  original top-up stood, nothing new was charged (sim P2-4). */
      replayed?: boolean;
    }
  | { ok: false; error: string; needsAuth?: boolean };

export type StartDepositResult =
  | { ok: true; url: string; amount: number }
  | { ok: false; error: string; needsAuth?: boolean };

/**
 * Which deposit channels to offer, read at REQUEST time.
 *
 * Called by the sheet when it opens rather than resolved in the root layout,
 * and that is the whole point: `DEPOSIT_METHODS_ENABLED` is a RUN_TIME var, but
 * several routes (`/task`, `/about`, `/how-it-works`, …) are fully prerendered,
 * so a layout-resolved list would be frozen into their flight payload at BUILD
 * time — the retract switch would work on dynamic pages and silently do nothing
 * on static ones. An action runs per request everywhere.
 */
export type PaymentLimits = {
  gateway: string;
  deposit: { minRm: number; maxRm: number };
  withdrawal: { minRm: number; maxRm: number };
};

/** The GlobePay production band, used until the backend answers (and if it
 *  never does): the sheet must never offer a floor the gateway will refuse. */
export const DEFAULT_PAYMENT_LIMITS: PaymentLimits = {
  gateway: 'unknown',
  deposit: { minRm: 30, maxRm: 10000 },
  withdrawal: { minRm: 50, maxRm: 50000 },
};

/**
 * The ACTIVE gateway's money bands, read from the backend per call — an
 * admin can switch gateways at runtime, and TGPay's floor (RM 50) is not
 * GlobePay's (RM 30). Public route, publishable key only. Any failure yields
 * the defaults so the sheet still opens.
 */
export async function getPaymentLimits(): Promise<PaymentLimits> {
  try {
    const parsed = parseOne(
      PaymentConfigSchema,
      await authedFetch(undefined, '/store/payments/config'),
    );
    if (!parsed) return DEFAULT_PAYMENT_LIMITS;
    return {
      gateway: parsed.gateway,
      deposit: { minRm: parsed.deposit.min_rm, maxRm: parsed.deposit.max_rm },
      withdrawal: {
        minRm: parsed.withdrawal.min_rm,
        maxRm: parsed.withdrawal.max_rm,
      },
    };
  } catch (error) {
    logger.error('[vault] payment limits load failed:', error);
    return DEFAULT_PAYMENT_LIMITS;
  }
}

export async function getDepositMethods(): Promise<DepositMethodCode[]> {
  const raw = process.env.DEPOSIT_METHODS_ENABLED;
  const enabled = enabledDepositMethods(raw);
  // Fail-open is deliberate (a typo must not leave customers unable to pay) but
  // must not be silent: this is the case where an operator believes a channel is
  // retracted and it is still being offered.
  if (raw?.trim() && enabled.length === DEPOSIT_METHODS.length) {
    const named = enabled.map((method) => method.code).join(',');
    if (raw.trim().toUpperCase() !== named) {
      logger.error(
        `[vault] DEPOSIT_METHODS_ENABLED="${raw}" matched no known channel — offering all of ${named}`,
      );
    }
  }
  return enabled.map((method) => method.code);
}

/**
 * Start a REAL top-up through the GlobePay365 gateway.
 *
 * Unlike `topUpCredits` this credits nothing and returns no balance: it hands
 * back the gateway's cashier URL, the customer pays there, and credit only
 * lands when their signed callback settles the deposit. So there is no
 * Idempotency-Key here — the backend mints a fresh reference per attempt and a
 * re-clicked button costs nothing but an abandoned deposit row.
 *
 * Whether the UI uses a real gateway is decided by NEXT_PUBLIC_PAYMENTS_PROVIDER
 * (anything but 'mock'); WHICH gateway is the backend's admin setting. This
 * action is only called in gateway mode.
 *
 * Both parameters are typed as what can actually ARRIVE, not what is allowed.
 * A server action is a public endpoint: the compiler constrains our own call
 * sites, but the wire carries whatever the caller sends, so narrowing
 * `paymentMethodCode` to `DepositMethodCode` would state a guarantee the
 * runtime does not have and make the guard below look redundant. `amount: number`
 * has read that way here since the mock-gateway days — hence its own typeof
 * check on the first line.
 */
export async function startDeposit(
  amount: number,
  paymentMethodCode: string = DEFAULT_DEPOSIT_METHOD,
): Promise<StartDepositResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter a valid amount.' };
  }
  // The backend allow-lists this too, but its list is the gateway's whole MYR
  // set (FPX/DN/BQR/OB) — ours is the narrower one this merchant actually has
  // provisioned, so an un-openable channel is refused here with a message
  // instead of surfacing as a gateway rejection.
  //
  // Re-checked against the RUNTIME set, not just the compiled one: a channel an
  // operator has retracted via DEPOSIT_METHODS_ENABLED must not still be
  // reachable by a stale client bundle or a hand-rolled POST, or the switch
  // would only hide the tile.
  const enabled = enabledDepositMethods(process.env.DEPOSIT_METHODS_ENABLED);
  if (
    !isDepositMethod(paymentMethodCode) ||
    !enabled.some((method) => method.code === paymentMethodCode)
  ) {
    return { ok: false, error: 'Pick a payment method.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const parsed = parseOne(
      DepositStartSchema,
      await authedFetch(token, '/store/credits/deposit', {
        method: 'POST',
        body: { amount, payment_method_code: paymentMethodCode },
      }),
    );
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return { ok: true, url: parsed.url, amount: parsed.amount };
  } catch (error) {
    logger.error('[vault] deposit start failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export type WithdrawBank = { bankCode: string; bankName: string };

export type WithdrawBanksResult =
  | { ok: true; banks: WithdrawBank[] }
  | { ok: false; error: string; needsAuth?: boolean };

/** Payout bank picker source — proxied through the backend (the gateway's
 *  bank-list endpoint carries our merchant code, so it never runs browser-side). */
export async function fetchWithdrawBanks(): Promise<WithdrawBanksResult> {
  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }
  try {
    const parsed = parseOne(
      WithdrawBanksSchema,
      await authedFetch(token, '/store/credits/withdraw/banks'),
    );
    if (!parsed) {
      return { ok: false, error: 'Could not load the bank list.' };
    }
    return { ok: true, banks: parsed.banks };
  } catch (error) {
    logger.error('[vault] withdraw banks failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export type SavedBankAccount = {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
  /**
   * When this destination may receive a payout — the server's verdict, never
   * recomputed here. A future instant = saved but still cooling off; null (or
   * absent) = it cannot be paid to at all until it is saved again. Both render
   * as visible-and-disabled; neither is hidden, which would read as a bug.
   */
  usableFrom?: string | null;
  /**
   * Whether the payout provider currently in use can pay to this bank. Saved
   * accounts survive a provider switch; one the new provider cannot reach
   * stays listed but disabled, with the reason, until it can be paid again.
   */
  supported?: boolean;
};

export type SavedBankAccountsResult =
  | { ok: true; accounts: SavedBankAccount[] }
  | { ok: false; error: string; needsAuth?: boolean };

/** The customer's saved payout accounts — the withdraw form's picker source. */
export async function fetchSavedBankAccounts(): Promise<SavedBankAccountsResult> {
  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }
  try {
    const parsed = parseOne(
      SavedBankAccountsSchema,
      await authedFetch(token, '/store/credits/withdraw/accounts'),
    );
    if (!parsed) {
      return { ok: false, error: 'Could not load your saved accounts.' };
    }
    return { ok: true, accounts: parsed.accounts };
  } catch (error) {
    logger.error('[vault] saved bank accounts failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

/** Save a payout account for reuse. The backend applies the same validation
 *  as the payout submit, so a saved account is always a submittable one. */
export async function addSavedBankAccount(input: {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
}): Promise<SavedBankAccountsResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (
    typeof input.bankCode !== 'string' ||
    typeof input.bankName !== 'string' ||
    typeof input.accountNumber !== 'string' ||
    typeof input.accountHolderName !== 'string'
  ) {
    return { ok: false, error: 'Fill in every bank field.' };
  }
  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }
  try {
    const parsed = parseOne(
      SavedBankAccountsSchema,
      await authedFetch(token, '/store/credits/withdraw/accounts', {
        method: 'POST',
        body: {
          bank_code: input.bankCode,
          bank_name: input.bankName,
          account_number: input.accountNumber,
          account_holder_name: input.accountHolderName,
        },
      }),
    );
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return { ok: true, accounts: parsed.accounts };
  } catch (error) {
    logger.error('[vault] save bank account failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

/** Remove a saved payout account. Idempotent server-side. */
export async function removeSavedBankAccount(
  id: string,
): Promise<SavedBankAccountsResult> {
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'Say which account to remove.' };
  }
  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }
  try {
    const parsed = parseOne(
      SavedBankAccountsSchema,
      await authedFetch(token, '/store/credits/withdraw/accounts', {
        method: 'DELETE',
        body: { id },
      }),
    );
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return { ok: true, accounts: parsed.accounts };
  } catch (error) {
    logger.error('[vault] remove bank account failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export type StartWithdrawalResult =
  | {
      ok: true;
      amount: number;
      balance: number;
      reference: string;
      /** 'held' — parked for admin approval, never submitted to the gateway
       *  (the debit above already happened). 'pending' — submitted, or the
       *  submit outcome was ambiguous; either way the sweep/callback resolves
       *  it from here. Mirrors the backend's StartWithdrawalResult#status. */
      status: 'pending' | 'held';
    }
  | { ok: false; error: string; needsAuth?: boolean };

/**
 * Start a REAL payout through the GlobePay365 gateway. The balance is debited
 * immediately (the returned `balance` reflects it); the bank transfer then
 * completes asynchronously, and a failed payout refunds the debit — so the
 * money is never both spendable and in flight.
 *
 * `idempotencyKey` comes from the CALLER, minted once per withdrawal ATTEMPT
 * and reused across retries of that attempt (see `topUpCredits` above and
 * `WithdrawForm`) — a key minted here per call would rotate on every retry
 * and bypass the backend's replay guard (PR #427), which exists precisely
 * for the debited-but-response-lost case: a server action can reject at the
 * action boundary (offline, 5xx, deployment-id rotation) AFTER the backend
 * already debited and submitted the payout, and a retry without the same key
 * would be a second debit and a second bank transfer. The fallback mint only
 * covers callers that never retry.
 *
 * Takes an `accountId`, never bank details: the destination is resolved
 * server-side from the caller's own saved accounts, inside the transaction that
 * debits. Do not re-add bank fields here — the backend ignores them, and
 * accepting them would suggest they still decide something.
 */
export async function startWithdrawal(input: {
  amount: number;
  accountId: string;
  idempotencyKey?: string;
}): Promise<StartWithdrawalResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (
    typeof input.amount !== 'number' ||
    !Number.isFinite(input.amount) ||
    input.amount <= 0
  ) {
    return { ok: false, error: 'Enter a valid amount.' };
  }
  if (typeof input.accountId !== 'string' || input.accountId === '') {
    return { ok: false, error: 'Select a saved bank account.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const parsed = parseOne(
      WithdrawStartSchema,
      await authedFetch(token, '/store/credits/withdraw', {
        method: 'POST',
        headers: {
          // See the doc comment above: caller-minted so a retry of the same
          // attempt replays instead of double-debiting.
          'Idempotency-Key': input.idempotencyKey ?? crypto.randomUUID(),
        },
        body: {
          amount: input.amount,
          account_id: input.accountId,
        },
      }),
    );
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return {
      ok: true,
      amount: parsed.amount,
      balance: parsed.balance,
      // Their W… id when the submit confirmed; our reference when the
      // outcome is still resolving asynchronously.
      reference: parsed.transactionId ?? parsed.merchantTransactionId,
      // `parsed.status` is optional on the wire (see WithdrawStartSchema) so a
      // storefront deployed ahead of the backend still parses. Absent means a
      // pre-094 backend, which has no held state — 'pending' is the accurate
      // default there, not a guess.
      status: parsed.status ?? 'pending',
    };
  } catch (error) {
    logger.error('[vault] withdrawal start failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// Buy site credit through the mock gateway (demo — no real payment). The fake
// card fields never leave the browser; only the amount is posted, and the
// backend re-validates it (the gateway declines amounts ending in .13).
//
// `idempotencyKey` comes from the CALLER, minted once per top-up ATTEMPT and
// reused across retries of that attempt (see TopUpSheet) — a key minted here
// per call would rotate on every retry and bypass the backend replay guard,
// which exists precisely for the credited-but-response-lost retry. The
// fallback mint only covers callers that never retry.
export async function topUpCredits(
  amount: number,
  idempotencyKey?: string,
): Promise<TopUpActionResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter a valid amount.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const parsed = parseOne(
      AmountBalanceSchema,
      await authedFetch(token, '/store/credits/topup', {
        method: 'POST',
        headers: {
          // Mandatory since the 2026-07-07 audit — a retried top-up without a
          // key would double-credit. Node 20+: crypto.randomUUID() is global.
          'Idempotency-Key': idempotencyKey ?? crypto.randomUUID(),
        },
        body: { amount },
      }),
    );
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return {
      ok: true,
      amount: parsed.amount,
      balance: parsed.balance,
      replayed: parsed.replayed === true,
    };
  } catch (error) {
    logger.error('[vault] top-up failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export type CreditTxn = {
  id: string;
  amount: number;
  // Any string, not `CreditReason` — mirrors CreditTransactionSchema: an
  // unlisted backend reason must still reach the UI (reasonLabel falls back
  // to a prettified generic label) instead of the row being dropped upstream.
  reason: string;
  createdAt: string;
  // Gateway reference on topup/cashout rows (what support quotes); null on
  // pack opens, buybacks and other internal rows.
  reference: string | null;
  // Channel + gateway-confirmed outcome behind that reference, so every money
  // row on the statement traces to the gateway record. Null when unknown.
  gateway: { method: string; status: string } | null;
};

export type TransactionsResult =
  | {
      ok: true;
      balance: number;
      topupTotal: number;
      spendTotal: number;
      transactions: CreditTxn[];
      page: number;
      hasMore: boolean;
    }
  | { ok: false; error: string; needsAuth?: boolean };

// Ledger page size — matches the backend default (PAGE_SIZE in store/credits).
// Not exported: 'use server' modules may only export async functions.
const TXN_PAGE_SIZE = 20;

// The credit ledger for the Transactions account page: lifetime totals + one
// page of rows (?page=N, newest first). The totals are computed over the FULL
// ledger server-side, so they stay accurate beyond the visible rows.
export async function getTransactions(
  page: number = 1,
): Promise<TransactionsResult> {
  // Validate at the boundary — a server action is a public endpoint.
  const safePage = sanePage(page);

  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to view your transactions.',
      needsAuth: true,
    };
  }
  try {
    const raw = await authedFetch(token, '/store/credits', {
      query: {
        limit: TXN_PAGE_SIZE,
        offset: (safePage - 1) * TXN_PAGE_SIZE,
      },
    });
    const totals = parseOne(CreditsSchema, raw);
    const rows = parseList(
      CreditTransactionSchema,
      (raw as { transactions?: unknown }).transactions,
    );
    return {
      ok: true,
      balance: totals?.balance ?? 0,
      topupTotal: totals?.topup_total ?? 0,
      spendTotal: totals?.spend_total ?? 0,
      transactions: rows.map((r) => ({
        id: r.id,
        amount: r.amount,
        reason: r.reason,
        createdAt: r.created_at,
        reference: r.reference ?? null,
        gateway: r.gateway ?? null,
      })),
      page: safePage,
      hasMore: totals?.has_more ?? false,
    };
  } catch (error) {
    logger.error('[credits] transactions load failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export type PendingDeposit = {
  /** The gateway reference support quotes. */
  reference: string;
  /** What we asked the gateway for — see PendingDepositSchema. */
  amount: number;
  /** FPX/BQR/… when the backend recorded one. */
  method: string | null;
  /** "just now" / "7 minutes ago", stamped HERE rather than in the component:
   *  the row renders on the server and again on hydration, and a clock read in
   *  either render would make the two disagree (and trips the React Compiler's
   *  impure-call rule). The 10-second refresh is what advances it. */
  startedLabel: string;
  /** Past the backend's chase window. The copy stops promising an imminent
   *  credit and points at support instead — see PendingDeposits. */
  overdue: boolean;
};

/** How long before a pending deposit stops being "confirming" and becomes a
 *  support case. Mirrors the backend's GLOBEPAY_STALE_AFTER_MS, which is also
 *  where it stops being served at all — so this only bites on a page left
 *  open, and stops that page claiming to confirm something indefinitely. */
const DEPOSIT_OVERDUE_MS = 60 * 60 * 1000;

/**
 * Top-ups the customer has started but that have not settled yet.
 *
 * The Transactions page reads the LEDGER, and a deposit writes nothing there
 * until it settles — so a customer who paid and came straight back saw a page
 * with no trace of their money and reasonably concluded it had failed. This is
 * the "we can see your payment" half.
 *
 * Returns a plain array and NEVER an error shape: it decorates a page that must
 * render regardless, so a failed read degrades to "no pending row" rather than
 * replacing the ledger with an error. The signed-out case is the same nothing —
 * the (account) layout has already gated the page by the time this runs.
 */
export async function getPendingDeposits(): Promise<PendingDeposit[]> {
  const token = await getAuthToken();
  if (!token) return [];
  try {
    const raw = await authedFetch(token, '/store/credits/deposit');
    // One instant for the whole list, so two rows started a second apart do not
    // read as if measured by different clocks.
    const now = Date.now();
    return parseList(
      PendingDepositSchema,
      (raw as { deposits?: unknown }).deposits,
    ).map((deposit) => {
      const startedAt = new Date(deposit.created_at).getTime();
      return {
        reference: deposit.merchant_transaction_id,
        amount: deposit.amount,
        method: deposit.payment_method_code ?? null,
        startedLabel: elapsedLabel(startedAt, now),
        overdue: now - startedAt > DEPOSIT_OVERDUE_MS,
      };
    });
  } catch (error) {
    logger.error('[credits] pending deposits load failed:', error);
    return [];
  }
}

export type ToggleShowcaseResult =
  | { ok: true; showcased: boolean }
  | { ok: false; error: string; needsAuth?: boolean };

export async function toggleShowcase(
  pullId: string,
  showcased: boolean,
): Promise<ToggleShowcaseResult> {
  if (typeof pullId !== 'string' || pullId.trim() === '') {
    return { ok: false, error: 'Invalid card.' };
  }
  // Server actions are public endpoints — guard the boolean at the boundary.
  if (typeof showcased !== 'boolean') {
    return { ok: false, error: 'Invalid showcase state.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const parsed = parseOne(
      VaultShowcaseSchema,
      await authedFetch(
        token,
        `/store/vault/${encodeURIComponent(pullId)}/showcase`,
        {
          method: 'POST',
          body: { showcased },
        },
      ),
    );
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    // Never act on a response for a different pull (backend bug / misrouting).
    if (parsed.pull_id !== pullId) {
      logger.error(
        `[vault] showcase toggle id mismatch: requested '${pullId}', got '${parsed.pull_id}'`,
      );
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return { ok: true, showcased: parsed.showcased };
  } catch (error) {
    logger.error(`[vault] showcase toggle failed for '${pullId}':`, error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export type BulkSellResult =
  | {
      ok: true;
      /** How many pulls actually sold + credited. */
      sold: number;
      /** How many could not be sold (already sold, delivering, not owned…). */
      failed: number;
      /** Total MYR credited across the sold pulls. */
      credited: number;
      /** New credit balance (Σ ledger) after the batch. */
      balance: number;
      /** The pull ids that actually sold — the client removes exactly these. */
      soldIds: string[];
      /** First per-pull failure reason, for a "N couldn't be sold — <why>" line. */
      firstError: string | null;
    }
  | { ok: false; error: string; needsAuth?: boolean };

// Bulk sell-back of many vaulted pulls in ONE request (POST
// /store/vault/buyback-batch). Replaces the old client loop that fired one
// /buyback per card — under the per-pull rate limiter that capped a bulk sell
// at ~10 cards and forced repeated presses. The backend sells each pull with
// the SAME atomic per-pull workflow, so no pull leaves the vault without a
// matching credit; un-sellable pulls are skipped and reported, the rest sell.
export async function sellBackPullsBatch(
  pullIds: string[],
): Promise<BulkSellResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (!Array.isArray(pullIds) || pullIds.length === 0) {
    return { ok: false, error: 'No cards selected.' };
  }
  const ids = pullIds.filter((x) => typeof x === 'string' && x.trim() !== '');
  if (ids.length === 0) {
    return { ok: false, error: 'No valid cards selected.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const raw = await authedFetch(token, '/store/vault/buyback-batch', {
      method: 'POST',
      body: { pull_ids: ids },
    });
    // The backend is ours, but a server action still validates its input at the
    // boundary — parse defensively so a shape drift can't render NaN or drop the
    // sold set (which the client uses to decide what to remove from the vault).
    const r = raw as {
      sold?: unknown;
      failed?: unknown;
      credited?: unknown;
      balance?: unknown;
      results?: { pull_id?: unknown; ok?: unknown; error?: unknown }[];
    };
    const results = Array.isArray(r.results) ? r.results : [];
    const soldIds = results
      .filter(
        (x): x is { pull_id: string; ok: true } =>
          !!x && x.ok === true && typeof x.pull_id === 'string',
      )
      .map((x) => x.pull_id);
    const firstFail = results.find(
      (x) => !!x && x.ok === false && typeof x.error === 'string',
    );
    const num = (v: unknown, fallback = 0) =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    return {
      ok: true,
      sold: num(r.sold, soldIds.length),
      failed: num(r.failed),
      credited: num(r.credited),
      balance: num(r.balance),
      soldIds,
      firstError:
        firstFail && typeof firstFail.error === 'string'
          ? firstFail.error
          : null,
    };
  } catch (error) {
    logger.error('[vault] bulk buyback failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// Instant sell-back of one vaulted pull. Safe to retry: the backend enforces
// once-per-pull at the database level.
export async function sellBackPull(pullId: string): Promise<SellBackResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (typeof pullId !== 'string' || pullId.trim() === '') {
    return { ok: false, error: 'Invalid card.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const parsed = parseOne(
      BuybackResultSchema,
      await authedFetch(
        token,
        `/store/vault/${encodeURIComponent(pullId)}/buyback`,
        {
          method: 'POST',
          body: {},
        },
      ),
    );
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return {
      ok: true,
      amount: parsed.amount,
      // Not rendered on the sell path; default keeps the type honest if a
      // backend ever omits it (the credit still landed — don't false-fail).
      percent: parsed.percent ?? 0,
      balance: parsed.balance,
    };
  } catch (error) {
    logger.error(`[vault] buyback failed for '${pullId}':`, error);
    return {
      ok: false,
      error: friendlyError(error, VAULT_RULES, VAULT_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}
