import {
  MedusaService,
  MedusaError,
  InjectManager,
  InjectTransactionManager,
  MedusaContext,
} from '@medusajs/framework/utils';
import type { Context } from '@medusajs/framework/types';
import Pack from './models/pack';
import Card from './models/card';
import PackOdds from './models/pack-odds';
import Pull from './models/pull';
import CreditTransaction from './models/credit-transaction';
import DeliveryOrder from './models/delivery-order';
import DeliveryOrderItem from './models/delivery-order-item';
import VipLevel from './models/vip-level';
import RewardsSettings from './models/rewards-settings';
import ReferralRelationship from './models/referral-relationship';
import Commission from './models/commission';
import {
  resolveBuybackRate,
  buybackAmount,
  instantDeadlineMs,
  type BuybackRate,
} from './buyback-rate';
import {
  EMPTY_TOTALS,
  foldLedgerRow,
  totalsToUsd,
  type LedgerTotals,
} from './credit-summary';
import { consumeExternalSen } from './external-funded';

// Auto-generates CRUD for each model: list/retrieve/create/update/delete<Model>s
// (e.g. listPacks, listCards, listPackOdds, createPulls,
// listCreditTransactions). Card = prize metadata, PackOdds = the weighted
// table (+ per-pack rarity), Pull = the result ledger doubling as the vault,
// CreditTransaction = the site-credit ledger written by buybacks.

const BALANCE_PAGE = 1000;

/** A signed credit-ledger write reason (mirrors CreditTransaction.reason). */
export type CreditMutationReason =
  | 'buyback'
  | 'topup'
  | 'pack_open'
  | 'adjustment'
  | 'direct_referral'
  | 'team_override'
  | 'commission_reversal'
  | 'cashout';

export type CreditMutationInput = {
  customerId: string;
  /** Signed USD decimal (never cents): negative = spend, positive = grant. */
  amount: number;
  reason: CreditMutationReason;
  /** Note (adjustment) / gateway ref (top-up); null otherwise. */
  reference?: string | null;
  /** The pull this credit came from (buyback rows only). */
  pullId?: string | null;
  /** Minimum allowed resulting balance in USD (default $0 — no overdraft). */
  floor?: number;
  /** The open's stable id (open_id), stamped on pack_open charge rows. */
  sourceTransactionId?: string | null;
};

export type SettleOpenInput = {
  customerId: string;
  /** Signed USD decimal — the open debit (always < 0). */
  amount: number;
  /** The open's stable id (open_id), stamped on the debit + commission rows. */
  sourceTransactionId: string;
  /** Debit against available (locked-aware) or raw balance. Default 'available'. */
  floorMode?: 'available' | 'raw';
};

export type CommissionPaid = {
  beneficiary: string;
  amountSen: number;
  matured: boolean;
};

export type SettleOpenResult = {
  id: string;
  balance: number;
  commissions: CommissionPaid[];
};

/** The transactional MikroORM manager surface we use for the advisory lock +
 *  the Σ-ledger read. `?` placeholders are inlined by MikroORM's formatQuery. */
type LedgerSqlManager = {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
};

class PacksModuleService extends MedusaService({
  Pack,
  Card,
  PackOdds,
  Pull,
  CreditTransaction,
  DeliveryOrder,
  DeliveryOrderItem,
  VipLevel,
  RewardsSettings,
  ReferralRelationship,
  Commission,
}) {
  // Commission engine globals. Reads the singleton row; falls back to defaults
  // when absent. COMMISSION_COOLDOWN_DAYS env override forces the demo (0) and
  // lets integration tests pin maturity deterministically without a DB write.
  // sharedContext lets Task 14 (settleOpen) call this inside its advisory-locked
  // transaction so the list runs on the same connection.
  @InjectManager()
  async rewardsSettings(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    commissionCooldownDays: number;
    teamOverridePct: number;
    overrideGenerationCap: number;
  }> {
    const [row] = await this.listRewardsSettings({}, { take: 1 }, sharedContext);
    const envCooldown = process.env.COMMISSION_COOLDOWN_DAYS;
    // Parse first; fall through to row-or-default when the value is not a
    // finite number (e.g. "abc" → NaN) so maturity arithmetic is never
    // corrupted by an invalid env var (CodeRabbit review fix).
    const parsedEnv = Math.trunc(Number(envCooldown));
    const commissionCooldownDays =
      envCooldown !== undefined && envCooldown !== '' && Number.isFinite(parsedEnv)
        ? Math.max(0, parsedEnv)
        : row
          ? Number(row.commission_cooldown_days)
          : 3;
    return {
      commissionCooldownDays,
      teamOverridePct: row ? Number(row.team_override_pct) : 0.2,
      overrideGenerationCap: row ? Number(row.override_generation_cap) : 100,
    };
  }

  // The instant/flat sell-back offer for a pull, composed from the SAME pure
  // helpers the buyback workflow credits with — so the reveal quote, the vault
  // quote, and the credit can never disagree. Removes the listPacks +
  // resolveBuybackRate re-query the open route did inline.
  async quoteBuyback(
    packSlug: string,
    pull: { rolled_at: Date | string; revealed_at?: Date | string | null },
    marketValue: number,
    nowMs: number = Date.now(),
  ): Promise<{
    percent: number;
    amount: number;
    rate_type: BuybackRate['rate_type'];
  }> {
    const [pack] = await this.listPacks({ slug: packSlug }, { take: 1 });
    const { percent, rate_type } = resolveBuybackRate(pack, pull, nowMs);
    return { percent, amount: buybackAmount(marketValue, percent), rate_type };
  }

  // Lifetime ledger totals (balance + money-in/out + external-funded spend),
  // paged so the result is exact at any ledger size. Reuses the pure fold so the
  // arithmetic is unit-tested. balance == Σ(amount); topupTotal == Σ top-ups;
  // spendTotal == Σ|negatives|; externalFundedSpendTotal == Σ external consumed
  // by opens (the VIP basis, refund-stable).
  async creditSummary(customerId: string): Promise<{
    balance: number;
    topupTotal: number;
    spendTotal: number;
    externalFundedSpendTotal: number;
  }> {
    let totals: LedgerTotals = EMPTY_TOTALS;
    for (let skip = 0; ; skip += BALANCE_PAGE) {
      const page = await this.listCreditTransactions(
        { customer_id: customerId },
        { skip, take: BALANCE_PAGE, order: { created_at: 'ASC' } },
      );
      for (const t of page) {
        totals = foldLedgerRow(totals, {
          amount: Number(t.amount),
          reason: t.reason,
          externalFundedCents: Number(
            (t as { external_funded_cents?: number | null })
              .external_funded_cents ?? 0,
          ),
        });
      }
      if (page.length < BALANCE_PAGE) break;
    }
    return totalsToUsd(totals);
  }

  // Customer credit balance = Σ(amount) over the append-only ledger. Kept as a
  // thin delegate so existing callers (pack detail affordability, etc.) are
  // unchanged.
  async creditBalance(customerId: string): Promise<number> {
    return (await this.creditSummary(customerId)).balance;
  }

  // Serialized, balance-checked credit-ledger write. Holds a per-customer
  // xact-scoped Postgres advisory lock across the Σ(ledger) re-read, the floor
  // check, and the insert — all in ONE transaction — so two concurrent credit
  // mutations for the same customer can't both pass the check and overspend
  // (fixes pack-open/pack-open and pack-open/admin-deduct double-spend). The
  // lock auto-releases on commit/rollback; arithmetic is done in integer cents.
  @InjectTransactionManager()
  async mutateCreditAtomic(
    input: CreditMutationInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ id: string; balance: number }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;

    // 1) Serialize all credit mutations for THIS customer on the locked txn.
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${input.customerId}`,
    ]);

    // 2) Re-read the balance AND the external-funded balance in cents inside the
    //    lock, in ONE scan (exact; soft-delete aware). external_funded_cents is
    //    only consumed by pack_open, but folding it into the existing balance
    //    scan avoids a second O(n) pass over the customer's ledger per open.
    const rows = await em.execute<
      { balance_cents: string | null; ext_cents: string | null }[]
    >(
      'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents, ' +
        'COALESCE(SUM(external_funded_cents), 0)::bigint AS ext_cents ' +
        'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
      [input.customerId],
    );
    const beforeCents = Number(rows[0]?.balance_cents ?? 0);
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

    // 2b) External-funded snapshot (Phase 1b) — uses the external balance from
    // the SAME locked read above, so the consume is race-safe against concurrent
    // top-ups/opens. A top-up adds its full amount as external money in; a
    // pack_open consumes min(price, external balance) and snapshots the NEGATIVE
    // consumed sen; buyback / adjustment never touch the external counter (0).
    let externalFundedCents = 0;
    if (input.reason === 'topup' && deltaCents > 0) {
      externalFundedCents = deltaCents;
    } else if (input.reason === 'pack_open' && deltaCents < 0) {
      const externalBalanceSen = Number(rows[0]?.ext_cents ?? 0);
      externalFundedCents = -consumeExternalSen(-deltaCents, externalBalanceSen);
    }

    // 3) Floor check — covers both "enough credit to open" and "no overdraft".
    if (deltaCents < 0 && beforeCents + deltaCents < floorCents) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        input.reason === 'pack_open'
          ? 'Not enough credits to open this pack.'
          : `Deduction exceeds the customer's balance ($${(
              beforeCents / 100
            ).toFixed(2)}) — the balance cannot go below $${(
              floorCents / 100
            ).toFixed(2)}.`,
      );
    }

    // 4) Insert the ledger row IN THE SAME TRANSACTION (thread sharedContext so
    //    the write enrolls in the locked txn — not a separate connection).
    const [txn] = await this.createCreditTransactions(
      [
        {
          customer_id: input.customerId,
          // Persist exact cents (matches the SUM(ROUND(...)) re-read + the
          // returned balance) so a non-cent input can't drift the ledger
          // vs. creditSummary's raw sum (CodeRabbit).
          amount: deltaCents / 100,
          reason: input.reason,
          pull_id: input.pullId ?? null,
          reference: input.reference ?? null,
          external_funded_cents: externalFundedCents,
          source_transaction_id: input.sourceTransactionId ?? null,
        },
      ],
      sharedContext,
    );

    return { id: txn.id, balance: (beforeCents + deltaCents) / 100 };
  }

  // Append-only reversal of a single ledger row (the open-saga compensation).
  // Holds the SAME per-customer advisory lock as mutateCreditAtomic, then writes
  // a mirror row: sign-flipped amount (refund) + sign-flipped external_funded_cents
  // (restores external balance; Task-1 fold nets the VIP basis). The original is
  // NEVER deleted — a reversed open keeps its history, which is mandatory once a
  // commission can reference it (spec §3 invariant 1). Idempotency: the caller
  // (Medusa saga compensation) runs this at most once per charge id.
  @InjectTransactionManager()
  async reverseCreditTransaction(
    transactionId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ id: string }> {
    const [original] = await this.listCreditTransactions(
      { id: transactionId },
      { take: 1 },
    );
    if (!original) {
      // Already gone / never written — nothing to reverse (compensation is a
      // best-effort undo; a missing charge means the forward step never ran).
      return { id: transactionId };
    }
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${original.customer_id}`,
    ]);

    const originalExt = Number(
      (original as { external_funded_cents?: number | null })
        .external_funded_cents ?? 0,
    );
    const [reversal] = await this.createCreditTransactions(
      [
        {
          customer_id: original.customer_id,
          amount: -Number(original.amount), // refund (flips the charge sign)
          reason: original.reason, // stays 'pack_open' so economy nets honestly
          pull_id: null, // unique pull_id belongs to the original only
          reference: `reversal:${transactionId}`,
          external_funded_cents: -originalExt, // restores external balance + basis
          source_transaction_id:
            (original as { source_transaction_id?: string | null })
              .source_transaction_id ?? null, // present after Task 4
        },
      ],
      sharedContext,
    );
    return { id: reversal.id };
  }

  // The atomic open settlement — the ONLY place an open debit (and, Phase 2a,
  // its commission) is written. Holds the per-customer advisory lock across the
  // balance read, floor check, debit insert, AND (Task 14) the commission fan-out
  // in ONE transaction, because the open is a compensation saga: the lock would
  // release if these were separate committed steps. This is mutateCreditAtomic
  // scaled up. Debit-only here; Task 14 extends it without changing this seam.
  @InjectTransactionManager()
  async settleOpen(
    input: SettleOpenInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<SettleOpenResult> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const deltaCents = Math.round(input.amount * 100);
    if (deltaCents >= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'settleOpen amount must be less than 0 (an open is a debit).',
      );
    }

    // 1) Serialize all credit mutations for THIS customer on the locked txn.
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${input.customerId}`,
    ]);

    // 2) Locked balance + external read (one scan), exact + soft-delete aware.
    const rows = await em.execute<
      { balance_cents: string | null; ext_cents: string | null }[]
    >(
      'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents, ' +
        'COALESCE(SUM(external_funded_cents), 0)::bigint AS ext_cents ' +
        'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
      [input.customerId],
    );
    const beforeCents = Number(rows[0]?.balance_cents ?? 0);
    const externalBalanceSen = Number(rows[0]?.ext_cents ?? 0);
    const externalFundedCents = -consumeExternalSen(-deltaCents, externalBalanceSen);

    // 3) Floor check against the available balance (Task 13 supplies the locked
    //    deduction; default 'available'). Debit-only Part A: available == raw,
    //    so this matches mutateCreditAtomic's floor exactly.
    const floorMode = input.floorMode ?? 'available';
    const lockedCents =
      floorMode === 'available'
        ? await this.lockedCommissionCents(input.customerId, em)
        : 0;
    const availableCents = beforeCents - lockedCents;
    if (availableCents + deltaCents < 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Not enough credits to open this pack.',
      );
    }

    // 4) Insert the debit row in the locked txn.
    const [txn] = await this.createCreditTransactions(
      [
        {
          customer_id: input.customerId,
          amount: deltaCents / 100,
          reason: 'pack_open',
          pull_id: null,
          reference: null,
          external_funded_cents: externalFundedCents,
          source_transaction_id: input.sourceTransactionId,
        },
      ],
      sharedContext,
    );

    // 5) Commission fan-out — Task 14 fills this in. Debit-only for now.
    const commissions: CommissionPaid[] = [];

    return {
      id: txn.id,
      balance: (beforeCents + deltaCents) / 100,
      commissions,
    };
  }

  // Locked (unspendable) commission credit for a customer, in cents, read inside
  // the caller's transaction. Part A: no commission rows exist, so this returns 0
  // (the method + its query land here so settleOpen's floor path is final; Task 13
  // gives it teeth once the commission table exists).
  private async lockedCommissionCents(
    _customerId: string,
    _em: LedgerSqlManager,
  ): Promise<number> {
    return 0;
  }

  // Top-N leaderboard computed in the DB (GROUP BY + ORDER BY + LIMIT), so it's
  // correct at any pull volume — replaces the old route that fetched an UNORDERED
  // 20k slice and ranked it in memory (wrong/jittery once pulls passed ~20k, #7).
  // points = Σ(pack price) × 100, volume = Σ(card market_value), pulls = count.
  // sinceMs = null → all-time; a timestamp → weekly window (rolled_at >= since).
  @InjectManager()
  async leaderboardTop(
    opts: { sinceMs: number | null; limit: number },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<
    { customer_id: string; pulls: number; points: number; volume: number }[]
  > {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const since =
      opts.sinceMs != null ? new Date(opts.sinceMs).toISOString() : null;

    const rows = await em.execute<
      {
        customer_id: string;
        pulls: string;
        points: string;
        volume_cents: string;
      }[]
    >(
      'SELECT pu.customer_id AS customer_id, ' +
        'COUNT(*) AS pulls, ' +
        'ROUND(COALESCE(SUM(pk.price), 0) * 100)::bigint AS points, ' +
        'ROUND(COALESCE(SUM(c.market_value), 0) * 100)::bigint AS volume_cents ' +
        'FROM pull pu ' +
        'LEFT JOIN pack pk ON pk.slug = pu.pack_id AND pk.deleted_at IS NULL ' +
        'LEFT JOIN card c ON c.handle = pu.card_id AND c.deleted_at IS NULL ' +
        'WHERE pu.deleted_at IS NULL AND pu.customer_id IS NOT NULL ' +
        // Branch on `since` rather than a nullable param: the
        // `(? IS NULL OR rolled_at >= ?)` form is non-sargable and would skip
        // the IDX_pull_rolled_at index on the weekly window (Sourcery).
        (since === null ? '' : 'AND pu.rolled_at >= ?::timestamptz ') +
        'GROUP BY pu.customer_id ' +
        'ORDER BY points DESC, pulls DESC, pu.customer_id ASC ' +
        'LIMIT ?',
      since === null ? [opts.limit] : [since, opts.limit],
    );

    return rows.map((r) => ({
      customer_id: r.customer_id,
      pulls: Number(r.pulls),
      points: Number(r.points),
      volume: Number(r.volume_cents) / 100,
    }));
  }

  // Insert a recruit→sponsor edge with the fraud guards (spec §7). Under ONE
  // transaction holding advisory locks on BOTH customer ids (sorted, so two
  // concurrent inserts can't deadlock), it: rejects self-referral; rejects a
  // cycle via a WITH RECURSIVE ancestor walk from the proposed sponsor; relies on
  // the unique customer_id index for immutability (a second link throws). The
  // route layer binds recruitId to the authenticated actor (Task 11) so a sponsor
  // can't insert recruits under themselves.
  @InjectTransactionManager()
  async linkSponsor(
    input: { recruitId: string; sponsorId: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ id: string }> {
    if (input.recruitId === input.sponsorId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'A customer cannot refer themselves.',
      );
    }
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    // Lock both ids in a stable (sorted) order to avoid deadlocks with a
    // concurrent reciprocal insert.
    const [lo, hi] = [input.recruitId, input.sponsorId].sort();
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`referral:${lo}`]);
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`referral:${hi}`]);

    // Cycle check: walk the proposed sponsor's upline; if the recruit appears,
    // linking would close a loop. customer_id is unique so the upline is a simple
    // path (no diamonds) — the recursion terminates.
    const ancestors = await em.execute<{ sponsor_id: string }[]>(
      `WITH RECURSIVE up AS (
         SELECT sponsor_id FROM referral_relationship
           WHERE customer_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT r.sponsor_id FROM referral_relationship r
           JOIN up ON r.customer_id = up.sponsor_id
           WHERE r.deleted_at IS NULL
       )
       SELECT sponsor_id FROM up WHERE sponsor_id = ? LIMIT 1`,
      [input.sponsorId, input.recruitId],
    );
    if (ancestors.length > 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'This referral would create a cycle in the sponsor tree.',
      );
    }

    // Immutability: the unique customer_id index rejects a second link. Surface a
    // clean error rather than a raw constraint violation.
    const existing = await this.listReferralRelationships(
      { customer_id: input.recruitId },
      { take: 1 },
    );
    if (existing.length > 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'This customer already has a sponsor.',
      );
    }

    const [rel] = await this.createReferralRelationships(
      [{ customer_id: input.recruitId, sponsor_id: input.sponsorId }],
      sharedContext,
    );
    return { id: rel.id };
  }

  // Stamp the first-seen time for a pull so the 30s instant window counts from
  // the reveal, not the pull. Idempotent: only the first call writes revealed_at;
  // later calls return the same deadline. Ownership enforced (a foreign/unknown
  // pull 404s — same error, no existence leak). The grace cap in instantDeadlineMs
  // means a late first call can't extend the window.
  async revealPull(
    pullId: string,
    customerId: string,
    nowMs: number = Date.now(),
  ): Promise<{ instant_deadline_ms: number }> {
    const [pull] = await this.listPulls({ id: pullId }, { take: 1 });
    if (!pull || pull.customer_id !== customerId) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Pull '${pullId}' not found.`,
      );
    }
    if (pull.revealed_at == null) {
      // First-write-wins under concurrent reveals: the FILTERED update only
      // stamps while revealed_at IS NULL (atomic at the DB), so racing calls
      // can't shift the anchor. Re-read to return whichever value persisted.
      await this.updatePulls({
        selector: { id: pull.id, revealed_at: null },
        data: { revealed_at: new Date(nowMs) },
      });
      const [fresh] = await this.listPulls({ id: pull.id }, { take: 1 });
      return {
        instant_deadline_ms: instantDeadlineMs(
          fresh.rolled_at,
          fresh.revealed_at,
        ),
      };
    }
    return {
      instant_deadline_ms: instantDeadlineMs(pull.rolled_at, pull.revealed_at),
    };
  }
}

export default PacksModuleService;
