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
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { sanePage } from '@/lib/page-param';
import { getAuthToken } from '@/lib/data/customer';
import { friendlyError, isAuthError, type ErrorRule } from '@/lib/errors';
import {
  parseList,
  parseOne,
  VaultItemSchema,
  VaultShowcaseSchema,
  BalanceSchema,
  AmountBalanceSchema,
  BuybackResultSchema,
  DepositStartSchema,
  WithdrawStartSchema,
  WithdrawBanksSchema,
  CreditsSchema,
  CreditTransactionSchema,
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

// Patterns local to the vault/credit actions (rate-limit, auth, the demo
// gateway decline, amount/already-sold/not-found). Order matters — first match.
const VAULT_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — give it a moment and try again.',
  ],
  [/unauthorized|not authenticated|401/i, 'Please log in to view your vault.'],
  [
    /declined/i,
    'Payment declined by the demo gateway — amounts ending in .13 always decline.',
  ],
  // Withdrawal messages are already customer-facing on the backend — pass
  // them through instead of flattening a gateway refusal into the fallback.
  [
    /could not start your withdrawal/i,
    'We could not start your withdrawal. Please check the bank details and try again.',
  ],
  [
    /withdrawals must be between/i,
    'Withdrawals must be between RM 30 and RM 1,000.',
  ],
  [/withdrawals are not open/i, 'Withdrawals are not open yet.'],
  [/insufficient/i, 'Not enough balance for that.'],
  [/amount/i, 'Enter a valid amount (up to RM 10,000, whole cents).'],
  [/already sold/i, 'This card was already sold back.'],
  [/not found|404/i, 'This card is no longer in your vault.'],
];
const VAULT_FALLBACK = 'Something went wrong. Please try again.';

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
      sdk.client.fetch('/store/vault', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      }),
      sdk.client.fetch('/store/credits/balance', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      }),
    ]);

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
      await sdk.client.fetch('/store/credits/balance', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      }),
    );
    return credit ? credit.balance : null;
  } catch (error) {
    logger.error('[vault] balance read failed:', error);
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
 * Start a REAL top-up through the GlobePay365 gateway.
 *
 * Unlike `topUpCredits` this credits nothing and returns no balance: it hands
 * back the gateway's cashier URL, the customer pays there, and credit only
 * lands when their signed callback settles the deposit. So there is no
 * Idempotency-Key here — the backend mints a fresh reference per attempt and a
 * re-clicked button costs nothing but an abandoned deposit row.
 *
 * Which gateway the UI uses is decided by NEXT_PUBLIC_PAYMENTS_PROVIDER; this
 * action is only called when it is 'globepay'.
 */
export async function startDeposit(
  amount: number,
): Promise<StartDepositResult> {
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
      DepositStartSchema,
      await sdk.client.fetch('/store/credits/deposit', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { amount },
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
      await sdk.client.fetch('/store/credits/withdraw/banks', {
        headers: { Authorization: `Bearer ${token}` },
      }),
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

export type StartWithdrawalResult =
  | { ok: true; amount: number; balance: number; reference: string }
  | { ok: false; error: string; needsAuth?: boolean };

/**
 * Start a REAL payout through the GlobePay365 gateway. The balance is debited
 * immediately (the returned `balance` reflects it); the bank transfer then
 * completes asynchronously, and a failed payout refunds the debit — so the
 * money is never both spendable and in flight. No Idempotency-Key: the backend
 * mints a fresh reference per attempt, and each attempt debits atomically.
 */
export async function startWithdrawal(input: {
  amount: number;
  bankCode: string;
  accountNumber: string;
  accountHolderName: string;
}): Promise<StartWithdrawalResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (
    typeof input.amount !== 'number' ||
    !Number.isFinite(input.amount) ||
    input.amount <= 0
  ) {
    return { ok: false, error: 'Enter a valid amount.' };
  }
  if (
    typeof input.bankCode !== 'string' ||
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
      WithdrawStartSchema,
      await sdk.client.fetch('/store/credits/withdraw', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: {
          amount: input.amount,
          bank_code: input.bankCode,
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
    return {
      ok: true,
      amount: parsed.amount,
      balance: parsed.balance,
      // Their W… id when the submit confirmed; our reference when the
      // outcome is still resolving asynchronously.
      reference: parsed.transactionId ?? parsed.merchantTransactionId,
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
      await sdk.client.fetch('/store/credits/topup', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
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
    const raw = await sdk.client.fetch('/store/credits', {
      headers: { Authorization: `Bearer ${token}` },
      query: {
        limit: TXN_PAGE_SIZE,
        offset: (safePage - 1) * TXN_PAGE_SIZE,
      },
      cache: 'no-store',
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
      await sdk.client.fetch(
        `/store/vault/${encodeURIComponent(pullId)}/showcase`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
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
    const raw = await sdk.client.fetch('/store/vault/buyback-batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
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
      await sdk.client.fetch(
        `/store/vault/${encodeURIComponent(pullId)}/buyback`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
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
