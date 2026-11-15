import { MedusaError } from '@medusajs/framework/utils';
import type { Context, InferTypeOf } from '@medusajs/framework/types';
import type { LedgerSqlManager } from './claim';
import type CreditTransaction from './models/credit-transaction';
import { BONUS_NOT_SPENDABLE_MESSAGE, bonusShareSen, consumeBonusSen } from './bonus-credit';
import { consumeExternalSen } from './external-funded';
import type { LedgerPayload, LedgerType } from './ledger';

// Credit posting: the one home of the per-customer credit lock (design
// plans/architecture-deepening/03-credit-posting-design.md). No service
// import, so the service and its helper files can all use it.

/** The per-customer credit lock key. Keep it byte-identical across releases:
 *  during a rolling deploy old and new pods must still exclude each other. */
export const creditLockKey = (customerId: string): string => `credit:${customerId}`;

/**
 * Takes the per-customer credit advisory lock for each id, on the caller's
 * transaction, in sorted order (deadlock-safe; the same default sort
 * reverseOpen always used). Re-entrant per session, so a posting composed
 * onto a transaction that already holds the key does not wait on itself.
 * Lock order contract: `adjust-idem:` → mint window → `credit:` →
 * `tickets:` / `delivery:` / pull FOR UPDATE, and `open:` → `credit:`; at
 * most one distinct `credit:` key per transaction except reverseOpen.
 * Errors pass through untouched (callers translate 55P03 themselves).
 */
export async function lockCredit(context: Context, ...customerIds: string[]): Promise<void> {
  const em = context.transactionManager as unknown as LedgerSqlManager | undefined;
  // An xact lock outside a transaction is released at once: never a lock.
  if (!em) throw new Error('lockCredit needs the caller\'s transaction.');
  for (const id of [...new Set(customerIds)].sort()) {
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [creditLockKey(id)]);
  }
}

/** The ledger row a posting writes with its credit, in the same transaction.
 *  A replayed posting writes neither. */
export type LedgerPart = {
  type: LedgerType;
  payload: LedgerPayload;
  /** Default: the credit row's own id (the admin Wallet tab's join). */
  refId?: string;
  /** Default: the posted amount, cent-rounded as stored. */
  walletDelta?: number | null;
  /** Default: null. */
  vaultDelta?: number | null;
};

/** A signed credit-ledger write reason (mirrors CreditTransaction.reason). */
export type CreditMutationReason =
  | 'buyback'
  | 'topup'
  | 'pack_open'
  | 'adjustment'
  | 'cashout'
  | 'voucher_claim'
  | 'reward_credit'
  | 'daily_reward'
  | 'delivery_fee'
  | 'bonus_grant'
  | 'coin_flip_win'
  | 'referral_commission';

type PostingFields = {
  customerId: string;
  /** Signed MYR (RM) decimal (never cents): negative = spend, positive = grant. */
  amount: number;
  /** Note (adjustment) / gateway ref (top-up); null otherwise. */
  reference?: string | null;
  /** Minimum allowed resulting balance in MYR (RM) (default RM 0 — no overdraft). */
  floor?: number;
  /** The open's stable id (open_id), stamped on pack_open charge rows. */
  sourceTransactionId?: string | null;
  /**
   * When set, the insert is IDEMPOTENT on this reference under the per-customer
   * advisory lock: if a row already carries it, that row is returned unchanged
   * instead of appending a second credit (top-up replay protection — security
   * audit 2026-06-23). The stored `reference` becomes this value. Mirrors the
   * `reversal:${id}` locked-dedupe the reversal posting uses; no DB
   * unique needed — the lock serializes check-then-insert per customer.
   */
  idempotencyReference?: string | null;
  /**
   * Bonus credit (spec 2026-10-07): the signed sen of this row that is
   * spend-only bonus. Only a 'bonus_grant' row may carry it, and it must equal
   * the row's amount in sen. A 'reward_credit' row (task / challenge prize) or
   * a 'voucher_claim' row (VIP voucher) is stamped whole-row bonus by mutateCreditAtomic itself (2026-10-11). Pack
   * opens take theirs bonus first (planPosting). A 'delivery_fee' charge takes its
   * bonus share itself (bonus first, ADR 0014); a 'delivery_fee' refund passes
   * the share its charge took, 0..amount, so it goes back as bonus.
   */
  bonusCents?: number;
  /** The paired ledger row, written by the posting itself. */
  ledger?: LedgerPart;
};

/** A posting for a general reason: top-up, cashout, adjustment, bonus grant,
 *  reward credit, voucher, delivery fee, pack open. */
export type GeneralPosting = PostingFields & {
  reason: Exclude<CreditMutationReason, 'buyback' | 'coin_flip_win' | 'pack_open' | 'referral_commission'>;
};

/** An open's debit: once per open id (open_id), bonus credit first. */
export type PackOpenPosting = PostingFields & {
  reason: 'pack_open';
  sourceTransactionId: string;
};

/** A sell-back credit: the pull it came from, and the bonus share of it
 *  (holdBp, ADR 0012) that must be played through before withdrawal. */
export type BuybackPosting = PostingFields & {
  reason: 'buyback';
  pullId: string;
  holdBp: number;
  ledger: LedgerPart & { type: 'SE' };
};

/** A won coin flip's payout: anchored on its round (`coin-flip:<round>`),
 *  with the round's CF row. */
export type CoinFlipPosting = PostingFields & {
  reason: 'coin_flip_win';
  roundId: string;
  ledger: LedgerPart & { type: 'CF' };
};

/** A weekly referral commission, keyed on its settlement line (the RF
 *  ref_id). The RF row is written FIRST and its replay is the double-pay
 *  guard: no credit row carries an anchor (D9). `unlocked` (D1, owner
 *  decision): a pay run posts every line in one transaction, and a credit
 *  lock per line would hold N locks in line order until commit, which can
 *  deadlock against reverseOpen's sorted locks. */
export type CommissionPosting = PostingFields & {
  reason: 'referral_commission';
  ledger: LedgerPart & { type: 'RF'; refId: string };
  unlocked?: true;
};

// The ledger columns a reversal reads by raw SQL on its own transaction (an
// ORM list would take a second pool connection; see mutateCreditAtomic).
export type LedgerReversalRow = {
  id: string;
  customer_id: string;
  amount: string;
  reason: InferTypeOf<typeof CreditTransaction>['reason'];
  reference: string | null;
  external_funded_cents: number | null;
  bonus_cents: number | null;
  source_transaction_id: string | null;
};

/** The append-only mirror of one ledger row (an open's compensation). The
 *  original is never deleted; idempotent on `reversal:<row id>`. */
export type ReversalPosting = {
  reversalOf: LedgerReversalRow;
  /** Default: the original's own. */
  sourceTransactionId?: string | null;
};

/** Every credit posting, keyed on reason (a reversal mirrors its original). */
export type CreditPosting =
  | GeneralPosting
  | PackOpenPosting
  | BuybackPosting
  | CoinFlipPosting
  | CommissionPosting
  | ReversalPosting;
export type CreditMutationInput = CreditPosting;

/** The locked Σ read a posting is planned against, in integer sen. */
export type PostingTotals = { balanceCents: number; bonusCents: number; externalCents: number };

/** One credit_transaction insert, as the generated create receives it. */
export type CreditRow = {
  customer_id: string;
  amount: number;
  reason: InferTypeOf<typeof CreditTransaction>['reason'];
  pull_id: string | null;
  reference: string | null;
  /** NULL, not 0, on a sell-back with nothing held (D9). */
  external_funded_cents: number | null;
  bonus_cents: number | null;
  source_transaction_id: string | null;
};

export type PostingPlan = {
  row: CreditRow;
  /** A positive posting may lift an AUTO freeze it repays. */
  unfreeze: boolean;
  balanceAfterCents: number;
  bonusAfterCents: number;
};

// Cents → customer-facing "RM 12.34" (matches the existing inline formatting
// in this file's error messages).
function rm(cents: number): string {
  return `RM ${(cents / 100).toFixed(2)}`;
}

// Store-facing insufficient-credits message for a pack open: names the price,
// the customer's (available) balance, and the exact shortfall so a newbie with
// RM 3 can see a RM 25 pack needs a RM 22 top-up (sim day-3 LOW, ux-friction).
export function insufficientCreditsMessage(
  costCents: number,
  haveCents: number,
): string {
  return (
    `Not enough credits to open this pack. It costs ${rm(costCents)} and ` +
    `you have ${rm(haveCents)} — top up at least ${rm(costCents - haveCents)}.`
  );
}

/**
 * The posting rules, pure: sign invariants, the bonus split, the external
 * (playthrough) snapshot and the floor, planned against the locked Σ read.
 * Throws the same MedusaErrors, in the same order, as mutateCreditAtomic did.
 */
export function planPosting(input: CreditPosting, totals: PostingTotals): PostingPlan {
  if ('reversalOf' in input) {
    const original = input.reversalOf;
    const row: CreditRow = {
      customer_id: original.customer_id,
      amount: -Number(original.amount), // refund / claw-back: flips the sign
      // Stays the original's ('pack_open' for an open), so economy nets
      // honestly and the open stops counting toward the VIP basis.
      reason: original.reason,
      pull_id: null, // unique pull_id belongs to the original only
      reference: `reversal:${original.id}`,
      external_funded_cents: -Number(original.external_funded_cents ?? 0), // restores basis
      bonus_cents: 0 - Number(original.bonus_cents ?? 0), // restores the bonus it spent
      source_transaction_id:
        input.sourceTransactionId ?? original.source_transaction_id ?? null,
    };
    return {
      row,
      // An open's refund never lifts an auto freeze (D2, owner decision).
      unfreeze: false,
      balanceAfterCents: totals.balanceCents + Math.round(row.amount * 100),
      bonusAfterCents: Math.max(0, totals.bonusCents) + (row.bonus_cents ?? 0),
    };
  }
  const beforeCents = totals.balanceCents;
  // Spend-only bonus credit (spec 2026-10-07): only a pack open may spend it
  // (settleOpen), so every other debit is floored against the NORMAL balance.
  // Clamped: a negative Σ (only reachable by deleting a buyback row whose
  // bonus was already spent) must never inflate the normal balance.
  const bonusBeforeCents = Math.max(0, totals.bonusCents);
  const deltaCents = Math.round(input.amount * 100);
  const floorCents = Math.round((input.floor ?? 0) * 100);

  // 2a) Sign invariants — fail LOUD on misuse rather than silently stamping
  // external_funded_cents = 0 and corrupting the VIP basis. A top-up is always
  // a credit (> 0); a pack_open is always a debit (< 0); free packs skip this
  // method entirely upstream. (adjustment is intentionally sign-agnostic.)
  if (input.reason === 'topup' && deltaCents <= 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'topup amount must be greater than 0.',
    );
  }
  if (input.reason === 'pack_open' && deltaCents >= 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'pack_open amount must be less than 0.',
    );
  }

  // 2a') bonus_grant: the whole row is bonus, either sign, and the bonus
  // balance can never go negative (a take-back larger than the bonus held).
  let bonusDeltaCents = 0;
  if (input.reason === 'bonus_grant') {
    if (deltaCents === 0 || input.bonusCents !== deltaCents) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'A bonus_grant row must carry bonusCents equal to its amount.',
      );
    }
    if (bonusBeforeCents + deltaCents < 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Bonus credit cannot go below RM 0 (bonus balance RM ${(
          bonusBeforeCents / 100
        ).toFixed(2)}).`,
      );
    }
    bonusDeltaCents = deltaCents;
  } else if (input.reason === 'delivery_fee') {
    // Bonus credit may pay delivery fees, bonus first like a pack open
    // (owner rule 2026-10-17, ADR 0014). A refund returns the bonus part its
    // charge took AS bonus, or request-then-cancel would launder bonus into
    // withdrawable cash.
    if (deltaCents < 0) {
      if (input.bonusCents) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          'A delivery fee charge takes its bonus share itself.',
        );
      }
      bonusDeltaCents = -Math.min(bonusBeforeCents, -deltaCents);
    } else {
      const back = input.bonusCents ?? 0;
      if (!Number.isInteger(back) || back < 0 || back > deltaCents) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          'A delivery fee refund can return at most its own amount as bonus.',
        );
      }
      bonusDeltaCents = back;
    }
  } else if (input.bonusCents) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Only a bonus_grant or delivery_fee row may carry bonusCents.',
    );
  } else if (
    input.reason === 'reward_credit' ||
    input.reason === 'voucher_claim'
  ) {
    // Task and weekly-challenge prizes and VIP level-up vouchers are
    // spend-only bonus credit too (operator rule 2026-10-11). Stamped HERE,
    // the one place their writers (claimTask, settleChallengeWinner,
    // claimReward) route through, so none can pay withdrawable credit by
    // forgetting a flag. The reasons stay their own, not bonus_grant: bonus_grant rows count against the
    // admin 24h mint ceiling (rollingAdjustmentMintCents), and task claims
    // must neither eat that allowance nor be blocked by it.
    if (bonusBeforeCents + deltaCents < 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Bonus credit cannot go below RM 0 (bonus balance RM ${(
          bonusBeforeCents / 100
        ).toFixed(2)}).`,
      );
    }
    bonusDeltaCents = deltaCents;
  } else if (input.reason === 'pack_open') {
    // Bonus credit is spent FIRST (spec 2026-10-07 §4.1); only the rest draws
    // on deposit money, so bonus-funded play banks no playthrough.
    bonusDeltaCents = 0 - consumeBonusSen(-deltaCents, bonusBeforeCents);
  }

  // 2b) External-funded snapshot (Phase 1b) — uses the external balance from
  // the SAME locked read above, so the consume is race-safe against concurrent
  // top-ups/opens. A top-up adds its full amount as external money in; a
  // pack_open consumes min(the price its bonus did not cover, external
  // balance) and snapshots the NEGATIVE consumed sen; adjustment never touches
  // the external counter (0).
  let externalFundedCents = 0;
  if (input.reason === 'topup' && deltaCents > 0) {
    externalFundedCents = deltaCents;
  } else if (input.reason === 'pack_open' && deltaCents < 0) {
    const externalBalanceSen = totals.externalCents;
    externalFundedCents = -consumeExternalSen(
      -deltaCents + bonusDeltaCents,
      externalBalanceSen,
    );
  }
  // Defensive: a pack_open debit snapshots the NEGATED consumed sen, so it
  // must be non-positive. If a future consumeExternalSen regression flipped
  // the sign, a positive value would inflate the VIP spend basis — fail loudly
  // rather than silently corrupt it.
  if (input.reason === 'pack_open' && externalFundedCents > 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'pack_open external_funded_cents must be <= 0.',
    );
  }

  // 3) Floor check — covers both "enough credit to open" and "no overdraft".
  //    Only a pack open or a delivery fee may spend bonus credit; every other
  //    debit is floored against the NORMAL balance (a bonus take-back was
  //    bounded above).
  const spendableCents =
    input.reason === 'pack_open' ||
    input.reason === 'delivery_fee' ||
    input.reason === 'bonus_grant' ||
    input.reason === 'reward_credit' ||
    input.reason === 'voucher_claim'
      ? beforeCents
      : beforeCents - bonusBeforeCents;
  if (deltaCents < 0 && spendableCents + deltaCents < floorCents) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      input.reason === 'pack_open'
        ? insufficientCreditsMessage(-deltaCents, beforeCents - floorCents)
        : beforeCents + deltaCents >= floorCents
          ? BONUS_NOT_SPENDABLE_MESSAGE
          : `Deduction exceeds the customer's balance (RM ${(
              beforeCents / 100
            ).toFixed(2)}) — the balance cannot go below RM ${(
              floorCents / 100
            ).toFixed(2)}.`,
    );
  }

  return {
    row: {
      customer_id: input.customerId,
      // Persist exact cents (matches the SUM(ROUND(...)) re-read + the
      // returned balance) so a non-cent input can't drift the ledger
      // vs. creditSummary's raw sum (CodeRabbit).
      amount: deltaCents / 100,
      reason: input.reason,
      pull_id: input.reason === 'buyback' ? input.pullId : null,
      // `reference` keeps the gateway/charge ref (or plain note) for
      // reconciliation; the idempotency anchor lives in source_transaction_id
      // (the replay check's target) so the two never clobber each other.
      reference: input.reason === 'coin_flip_win' ? input.roundId : (input.reference ?? null),
      // A sell-back's bonus share is held for packs: stamped as external money
      // in, like a deposit, so opens consume it and the playthrough gate
      // counts it (DEPOSITED_PT_SEN_SQL). Rounded up, toward the locked side.
      // A commission row stamps neither (NULL, D9).
      external_funded_cents:
        input.reason === 'buyback'
          ? bonusShareSen(deltaCents, input.holdBp) || null
          : input.reason === 'referral_commission'
            ? null
            : externalFundedCents,
      bonus_cents:
        input.reason === 'buyback' || input.reason === 'referral_commission'
          ? null
          : bonusDeltaCents,
      source_transaction_id:
        input.reason === 'coin_flip_win'
          ? `coin-flip:${input.roundId}`
          : (input.idempotencyReference ?? input.sourceTransactionId ?? null),
    },
    // A sell-back and a commission lift an AUTO freeze after commit
    // (buyback-pull.ts, the pay route and job); a frozen account cannot flip
    // (coin-flip.ts), so a win never lifts one.
    unfreeze:
      deltaCents > 0 &&
      input.reason !== 'buyback' &&
      input.reason !== 'coin_flip_win' &&
      input.reason !== 'referral_commission',
    balanceAfterCents: beforeCents + deltaCents,
    bonusAfterCents: bonusBeforeCents + bonusDeltaCents,
  };
}
