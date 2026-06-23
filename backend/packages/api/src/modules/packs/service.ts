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
import CustomerAccountState from './models/customer-account-state';
import AdminActionAudit from './models/admin-action-audit';
import VipMemberState from './models/vip-member-state';
import VipRewardGrant from './models/vip-reward-grant';
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
import {
  directReferralPctForLevel,
  directCommissionSen,
  teamOverrideSchedule,
} from './referral-commission';
import { levelForSpend } from './vip-ladder';
import { levelsToGrant, rewardsForLevel } from './vip-rewards';
import { fromSen } from './money';
import {
  validateRewardsPatch,
  type RewardsSettingsPatch,
  type RewardsSettingsView,
} from './rewards-settings-validate';

// Postgres unique-violation detector (SQLSTATE 23505) for the commission
// idempotency index. See settleOpen's commission catch for the exact semantics
// — a 23505 there rejects the whole duplicate open; it does NOT silently no-op.
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '23505';
}

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
  CustomerAccountState,
  AdminActionAudit,
  VipMemberState,
  VipRewardGrant,
}) {
  // Commission engine globals. Reads the singleton row; falls back to defaults
  // when absent. COMMISSION_COOLDOWN_DAYS env override forces the demo (0) and
  // lets integration tests pin maturity deterministically without a DB write.
  // sharedContext lets Task 14 (settleOpen) call this inside its advisory-locked
  // transaction so the list runs on the same connection.
  @InjectManager()
  async rewardsSettings(@MedusaContext() sharedContext: Context = {}): Promise<{
    commissionCooldownDays: number;
    teamOverridePct: number;
    overrideGenerationCap: number;
  }> {
    const [row] = await this.listRewardsSettings(
      {},
      { take: 1 },
      sharedContext,
    );
    const envCooldown = process.env.COMMISSION_COOLDOWN_DAYS;
    // Parse first; fall through to row-or-default when the value is not a
    // finite number (e.g. "abc" → NaN) so maturity arithmetic is never
    // corrupted by an invalid env var (CodeRabbit review fix).
    const parsedEnv = Math.trunc(Number(envCooldown));
    const commissionCooldownDays =
      envCooldown !== undefined &&
      envCooldown !== '' &&
      Number.isFinite(parsedEnv)
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
        { skip, take: BALANCE_PAGE, order: { created_at: 'ASC', id: 'ASC' } },
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
      externalFundedCents = -consumeExternalSen(
        -deltaCents,
        externalBalanceSen,
      );
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

    // Auto-clear an AUTO freeze if this inflow repays the debt. projectedBalance
    // is computed from the committed snapshot (beforeCents) + the just-inserted
    // delta — never re-read after the insert (MikroORM UoW buffers until flush,
    // so a raw SELECT inside the same txn would NOT see the new row).
    if (deltaCents > 0) {
      await this.maybeAutoUnfreeze(
        input.customerId,
        beforeCents + deltaCents,
        sharedContext,
      );
    }

    return { id: txn.id, balance: (beforeCents + deltaCents) / 100 };
  }

  // Append-only reversal of a single ledger row (the open-saga compensation).
  // Holds the SAME per-customer advisory lock as mutateCreditAtomic, then writes
  // a mirror row: sign-flipped amount (refund) + sign-flipped external_funded_cents
  // (restores external balance; Task-1 fold nets the VIP basis). The original is
  // NEVER deleted — a reversed open keeps its history, which is mandatory once a
  // commission can reference it (spec §3 invariant 1). Idempotent under the
  // lock (below): a repeated compensation of the same charge returns the
  // existing reversal rather than appending a second full refund.
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

    // Idempotency (Codex review): a saga that double-compensates the same charge
    // must NOT append a second refund. Under the lock, if a reversal row for this
    // charge already exists, return it as a no-op. `reversal:${id}` is the
    // per-charge reversal key.
    const [existingReversal] = await this.listCreditTransactions(
      { reference: `reversal:${transactionId}` },
      { take: 1 },
    );
    if (existingReversal) {
      return { id: existingReversal.id };
    }

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

  // Cascading reversal of an entire open (Phase 2b) — the saga compensation that
  // claws back EVERY commission paid for an open, not just the recruit's debit.
  // ONE transaction. Collects all originals sharing the open_id (the pack_open
  // debit + every direct/override commission credit), locks each touched customer
  // (sorted -> deadlock-safe), and appends an append-only compensating row per
  // original, idempotent via reference `reversal:${rowId}`. Commission claw-backs
  // post as 'commission_reversal' and flip the lifecycle row to 'reversed'; the
  // debit refund keeps reason 'pack_open' (nets the open's external basis, exactly
  // like reverseCreditTransaction — an aborted open correctly stops counting toward
  // VIP basis; there is no separate VIP projection to inverse). Re-running adds
  // nothing (returns reversed: 0). Exactly-once rests on the sorted credit: locks
  // + the per-row reference check (no DB unique on reference; a 3a admin reverse
  // path MUST take the same credit: locks).
  @InjectTransactionManager()
  async reverseOpen(
    sourceTransactionId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ reversed: number }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;

    // 1) Collect ALL originals for this open, PAGED — a full compensation must
    //    never silently truncate (a single capped fetch could leave commissions
    //    unreversed). Exclude compensating rows from a prior run: the debit
    //    reversal also carries reason 'pack_open', so filter on the reference
    //    prefix, not reason alone.
    const PAGE = 1000;
    let all = await this.listCreditTransactions(
      { source_transaction_id: sourceTransactionId },
      { skip: 0, take: PAGE, order: { created_at: 'ASC', id: 'ASC' } },
    );
    for (let skip = PAGE; all.length === skip; skip += PAGE) {
      const next = await this.listCreditTransactions(
        { source_transaction_id: sourceTransactionId },
        { skip, take: PAGE, order: { created_at: 'ASC', id: 'ASC' } },
      );
      all = all.concat(next);
    }
    const originals = all.filter((r) => {
      const ref = String((r as { reference?: string | null }).reference ?? '');
      if (ref.startsWith('reversal:')) return false;
      return (
        r.reason === 'pack_open' ||
        r.reason === 'direct_referral' ||
        r.reason === 'team_override'
      );
    });
    if (originals.length === 0) return { reversed: 0 };

    // 2) Lock every touched customer in a stable (sorted) order on the credit:
    //    keyspace — deadlock-safe with concurrent opens/reversals. (linkSponsor's
    //    sorted-lock technique, on the credit: keyspace used by the ledger path.)
    const customerIds = [
      ...new Set(originals.map((r) => r.customer_id)),
    ].sort();
    for (const cid of customerIds) {
      await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `credit:${cid}`,
      ]);
    }

    // 3a) Snapshot committed raw balance per touched customer BEFORE writes (MikroORM
    //     UoW buffers ORM inserts; a raw em.execute read inside the same txn only sees
    //     committed rows — projection must use pre-snapshot + per-row delta).
    const preBalCents = new Map<string, number>();
    for (const cid of customerIds) {
      const [row] = await em.execute<{ b: string | null }[]>(
        'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS b FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
        [cid],
      );
      preBalCents.set(cid, Number(row?.b ?? 0));
    }

    // 3b) Per-row append-only compensation, idempotent on reference `reversal:${id}`.
    let reversed = 0;
    const deltaMap = new Map<string, number>(); // per-customer reversal delta in cents
    for (const original of originals) {
      const [existing] = await this.listCreditTransactions(
        { reference: `reversal:${original.id}` },
        { take: 1 },
      );
      if (existing) continue; // already reversed — no-op
      const isCommission =
        original.reason === 'direct_referral' ||
        original.reason === 'team_override';
      const originalExt = Number(
        (original as { external_funded_cents?: number | null })
          .external_funded_cents ?? 0,
      );
      const [rev] = await this.createCreditTransactions(
        [
          {
            customer_id: original.customer_id,
            amount: -Number(original.amount), // refund / claw-back
            reason: isCommission ? 'commission_reversal' : original.reason,
            pull_id: null,
            reference: `reversal:${original.id}`,
            external_funded_cents: -originalExt, // restores basis (0 for commissions)
            source_transaction_id: sourceTransactionId,
          },
        ],
        sharedContext,
      );
      if (isCommission) {
        // Flip the lifecycle row to 'reversed' + anchor the reversal, on the
        // locked connection. Idempotent via the status guard.
        await em.execute(
          `UPDATE commission
              SET status = 'reversed', reversal_transaction_id = ?, updated_at = now()
            WHERE credit_transaction_id = ? AND status <> 'reversed' AND deleted_at IS NULL`,
          [rev.id, original.id],
        );
      }
      deltaMap.set(
        original.customer_id,
        (deltaMap.get(original.customer_id) ?? 0) +
          Math.round(Number(original.amount) * 100),
      );
      reversed++;
    }

    // Phase 3a: auto-freeze any customer whose projected balance after the reversal
    // is negative. Projection avoids re-reading (ORM UoW not yet flushed).
    for (const cid of customerIds) {
      const projectedCents =
        (preBalCents.get(cid) ?? 0) - (deltaMap.get(cid) ?? 0);
      if (projectedCents < 0) {
        await this.freezeAccountIfNotAlready(
          cid,
          'auto',
          `clawback:${sourceTransactionId}`,
          sharedContext,
        );
      }
    }

    return { reversed };
  }

  // Freeze the account unconditionally (caller has already determined the balance
  // is projected negative). Returns true if the account ends up frozen (or was
  // already frozen). Used by reverseOpen / reverseCommission after they compute
  // the post-reversal balance from a pre-reversal snapshot + delta.
  private async freezeAccountIfNotAlready(
    customerId: string,
    cause: 'auto' | 'manual',
    reason: string,
    sharedContext: Context,
  ): Promise<boolean> {
    const [existing] = await this.listCustomerAccountStates(
      { customer_id: customerId },
      { take: 1 },
      sharedContext,
    );
    if (existing) {
      if (existing.frozen) return true; // already frozen (manual stays sticky)
      await this.updateCustomerAccountStates(
        {
          selector: { id: existing.id },
          data: {
            frozen: true,
            cause,
            frozen_reason: reason,
            frozen_by: null,
            frozen_at: new Date(),
            unfrozen_at: null,
            unfreeze_cause: null,
          },
        },
        sharedContext,
      );
    } else {
      await this.createCustomerAccountStates(
        [
          {
            customer_id: customerId,
            frozen: true,
            cause,
            frozen_reason: reason,
          },
        ],
        sharedContext,
      );
    }
    return true;
  }

  // Auto-clear an AUTO freeze once a repaying inflow brings the projected balance
  // back to >= 0. projectedBalanceCents = committed snapshot + just-inserted delta
  // (never re-read after insert — MikroORM UoW buffers until flush, so a raw SQL
  // read inside the same txn would NOT see the new row). A MANUAL freeze is never
  // auto-lifted. SYSTEM event — recorded on the state row, NOT in admin_action_audit.
  private async maybeAutoUnfreeze(
    customerId: string,
    projectedBalanceCents: number,
    sharedContext: Context,
  ): Promise<void> {
    if (projectedBalanceCents < 0) return;
    const [state] = await this.listCustomerAccountStates(
      { customer_id: customerId, frozen: true, cause: 'auto' },
      { take: 1 },
      sharedContext,
    );
    if (!state) return;
    await this.updateCustomerAccountStates(
      {
        selector: { id: state.id },
        data: {
          frozen: false,
          unfrozen_at: new Date(),
          unfreeze_cause: 'repaid',
        },
      },
      sharedContext,
    );
  }

  // Admin commission-scoped reversal (Phase 3a). Claws back EVERY commission row
  // for the target's open (all generations) but leaves the recruit's pack_open
  // debit intact — unlike reverseOpen, which also refunds the recruit. Same
  // sorted credit: lock + per-row reversal:${id} idempotency discipline as
  // reverseOpen (2b §3.1). Writes one audit row in the same txn.
  @InjectTransactionManager()
  async reverseCommission(
    input: { commissionId: string; adminId: string; reason: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ reversed: number; froze: string[] }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const [target] = await this.listCommissions(
      { id: input.commissionId },
      { take: 1 },
      sharedContext,
    );
    if (!target) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Commission '${input.commissionId}' not found.`,
      );
    }
    const open = target.source_transaction_id;

    // All commission CREDIT rows for this open (every generation). Fetch all
    // rows for the open and filter to commission reasons — same pattern as
    // reverseOpen (no array-filter reliance on MedusaService list).
    const allRows = await this.listCreditTransactions(
      { source_transaction_id: open },
      { take: 1000, order: { created_at: 'ASC', id: 'ASC' } },
    );
    const credits = allRows.filter(
      (r) =>
        (r.reason === 'direct_referral' || r.reason === 'team_override') &&
        !String(
          (r as { reference?: string | null }).reference ?? '',
        ).startsWith('reversal:'),
    );
    if (credits.length === 0) return { reversed: 0, froze: [] };

    // Sorted credit: locks across every touched beneficiary (deadlock-safe).
    const beneficiaries = [
      ...new Set(credits.map((c) => c.customer_id)),
    ].sort();
    for (const cid of beneficiaries) {
      await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `credit:${cid}`,
      ]);
    }

    // Snapshot the committed raw balance for each beneficiary BEFORE writing any
    // reversals. MikroORM's UoW buffers ORM inserts until flush, so a raw-SQL
    // read inside the same txn would NOT see ORM-created rows — we must compute
    // the projected post-reversal balance from the committed snapshot + the delta.
    const preBalanceCentsMap = new Map<string, number>();
    for (const cid of beneficiaries) {
      const [row] = await em.execute<{ b: string | null }[]>(
        'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS b FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
        [cid],
      );
      preBalanceCentsMap.set(cid, Number(row?.b ?? 0));
    }

    let reversed = 0;
    const reversedCentsMap = new Map<string, number>(); // per-beneficiary delta (positive = clawed back)
    for (const original of credits) {
      const [existing] = await this.listCreditTransactions(
        { reference: `reversal:${original.id}` },
        { take: 1 },
        sharedContext,
      );
      if (existing) continue; // idempotent no-op
      const [rev] = await this.createCreditTransactions(
        [
          {
            customer_id: original.customer_id,
            amount: -Number(original.amount),
            reason: 'commission_reversal',
            pull_id: null,
            reference: `reversal:${original.id}`,
            external_funded_cents: 0, // commissions carry no external basis
            source_transaction_id: open,
          },
        ],
        sharedContext,
      );
      await em.execute(
        `UPDATE commission SET status = 'reversed', reversal_transaction_id = ?, updated_at = now()
          WHERE credit_transaction_id = ? AND status <> 'reversed' AND deleted_at IS NULL`,
        [rev.id, original.id],
      );
      // Accumulate per-beneficiary reversal amount (in cents).
      const prevDelta = reversedCentsMap.get(original.customer_id) ?? 0;
      reversedCentsMap.set(
        original.customer_id,
        prevDelta + Math.round(Number(original.amount) * 100),
      );
      reversed++;
    }

    // Auto-freeze any beneficiary whose projected post-reversal balance is negative.
    // We pass projectedCents to avoid a raw-SQL re-read that cannot see the ORM-buffered
    // reversal rows (MikroORM UoW flushes lazily; raw em.execute reads committed state only).
    const froze: string[] = [];
    for (const cid of beneficiaries) {
      const preCents = preBalanceCentsMap.get(cid) ?? 0;
      const deltaCents = reversedCentsMap.get(cid) ?? 0; // amount clawed back (positive)
      const projectedCents = preCents - deltaCents;
      if (projectedCents < 0) {
        if (
          await this.freezeAccountIfNotAlready(
            cid,
            'auto',
            `clawback:${open}`,
            sharedContext,
          )
        )
          froze.push(cid);
      }
    }

    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'commission',
          entity_id: input.commissionId,
          action: 'reverse_commission',
          before: { source_transaction_id: open, reversed_rows: reversed },
          after: { froze },
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return { reversed, froze };
  }

  // Admin per-commission status flip: available|pending → suspended.
  // The suspended status is counted as locked in lockedCommissionCents, so
  // the beneficiary's availableBalance drops automatically without any
  // additional balance-mutation step. Takes the per-beneficiary advisory lock
  // to serialise concurrent balance reads, then flips the status and writes an
  // audit row in the same transaction.
  @InjectTransactionManager()
  async suspendCommission(
    input: { commissionId: string; adminId: string; reason: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ status: 'suspended' }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const [c] = await this.listCommissions(
      { id: input.commissionId },
      { take: 1 },
      sharedContext,
    );
    if (!c) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Commission '${input.commissionId}' not found.`,
      );
    }
    if (c.status === 'reversed') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'A reversed commission cannot be suspended.',
      );
    }
    if (c.status === 'suspended') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Commission is already suspended.',
      );
    }
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${c.beneficiary}`,
    ]);
    await this.updateCommissions(
      { selector: { id: c.id }, data: { status: 'suspended' } },
      sharedContext,
    );
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'commission',
          entity_id: c.id,
          action: 'suspend_commission',
          before: { status: c.status },
          after: { status: 'suspended' },
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return { status: 'suspended' };
  }

  // Admin per-commission status flip: suspended → pending|available.
  // The restored status is determined by the authoritative maturity predicate
  // (matures_at <= now() → available, else pending) rather than a stored prior
  // value, so a commission that matured while suspended comes back as available.
  @InjectTransactionManager()
  async unsuspendCommission(
    input: { commissionId: string; adminId: string; reason: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ status: 'pending' | 'available' }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const [c] = await this.listCommissions(
      { id: input.commissionId },
      { take: 1 },
      sharedContext,
    );
    if (!c) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Commission '${input.commissionId}' not found.`,
      );
    }
    if (c.status !== 'suspended') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Only a suspended commission can be unsuspended.',
      );
    }
    // Restore from the authoritative read-predicate, not a stored prior value.
    const next: 'pending' | 'available' =
      new Date(c.matures_at).getTime() <= Date.now() ? 'available' : 'pending';
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${c.beneficiary}`,
    ]);
    await this.updateCommissions(
      { selector: { id: c.id }, data: { status: next } },
      sharedContext,
    );
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'commission',
          entity_id: c.id,
          action: 'unsuspend_commission',
          before: { status: c.status },
          after: { status: next },
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return { status: next };
  }

  // Admin-initiated MANUAL account freeze. A manual freeze is STICKY: it
  // overrides any existing AUTO freeze (sets cause='manual', frozen_by=adminId)
  // and will NOT be lifted by maybeAutoUnfreeze (which only touches cause='auto').
  // Takes the per-customer credit: advisory lock to serialise with the auto-freeze
  // / auto-unfreeze paths, then list-then-create-or-update the state row, and
  // writes an admin_action_audit row in the same transaction.
  @InjectTransactionManager()
  async setManualFreeze(
    input: { customerId: string; adminId: string; reason: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ frozen: true }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${input.customerId}`,
    ]);
    const [existing] = await this.listCustomerAccountStates(
      { customer_id: input.customerId },
      { take: 1 },
      sharedContext,
    );
    const before = existing
      ? { frozen: existing.frozen, cause: existing.cause }
      : null;
    if (existing) {
      await this.updateCustomerAccountStates(
        {
          selector: { id: existing.id },
          data: {
            frozen: true,
            cause: 'manual',
            frozen_reason: input.reason,
            frozen_by: input.adminId,
            frozen_at: new Date(),
            unfrozen_at: null,
            unfreeze_cause: null,
          },
        },
        sharedContext,
      );
    } else {
      await this.createCustomerAccountStates(
        [
          {
            customer_id: input.customerId,
            frozen: true,
            cause: 'manual',
            frozen_reason: input.reason,
            frozen_by: input.adminId,
            frozen_at: new Date(),
          },
        ],
        sharedContext,
      );
    }
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'customer',
          entity_id: input.customerId,
          action: 'freeze',
          before,
          after: { frozen: true, cause: 'manual' },
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return { frozen: true };
  }

  // Admin-initiated MANUAL account unfreeze. Clears the freeze regardless of
  // whether it was AUTO or MANUAL — an admin explicitly deciding to lift the
  // freeze overrides both. Takes the same credit: advisory lock, updates the
  // state row (frozen=false, unfreeze_cause='admin'), and writes an audit row.
  @InjectTransactionManager()
  async clearManualFreeze(
    input: { customerId: string; adminId: string; reason: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ frozen: false }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${input.customerId}`,
    ]);
    const [existing] = await this.listCustomerAccountStates(
      { customer_id: input.customerId },
      { take: 1 },
      sharedContext,
    );
    if (existing) {
      await this.updateCustomerAccountStates(
        {
          selector: { id: existing.id },
          data: {
            frozen: false,
            unfrozen_at: new Date(),
            unfreeze_cause: 'admin',
          },
        },
        sharedContext,
      );
    }
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'customer',
          entity_id: input.customerId,
          action: 'unfreeze',
          before: existing ? { frozen: existing.frozen } : null,
          after: { frozen: false },
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return { frozen: false };
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
    // sourceTransactionId is the commission idempotency key (open_id). Reject an
    // empty/missing one at the boundary so a bad caller can't write rows that
    // escape the partial-unique index (Sourcery review).
    if (!input.sourceTransactionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'settleOpen requires a non-empty sourceTransactionId (the open_id).',
      );
    }

    // 1) Serialize all credit mutations for THIS customer on the locked txn.
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${input.customerId}`,
    ]);

    // 1a) Freeze gate — must run inside the lock so a concurrent unfreeze can't
    //     race past this check before the debit lands.
    if (await this.isFrozen(input.customerId, sharedContext)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'This account is frozen.',
      );
    }

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
    const externalFundedCents = -consumeExternalSen(
      -deltaCents,
      externalBalanceSen,
    );

    // 3) Floor check against the AVAILABLE balance (raw − locked commission).
    //    Every open debit is locked-aware — there is no raw-balance opt-out, so a
    //    debit can never spend credit backed by pending/locked commission (Codex
    //    review removed the unused floorMode:'raw' bypass).
    const lockedCents = await this.lockedCommissionCents(input.customerId, em);
    const availableCents = beforeCents - lockedCents;
    if (availableCents + deltaCents < 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Not enough credits to open this pack.',
      );
    }

    // 4) Idempotency pre-check + debit insert (Phase 3b).
    // MikroORM's Unit of Work buffers ORM inserts until flush (transaction end), so
    // a 23505 from the debit row's partial-unique index fires at commit time — AFTER
    // settleOpen returns — where dbErrorMapper would intercept it before our catch.
    // Instead we do an explicit pre-check (raw SQL, fires immediately inside the
    // advisory lock) so a replayed no-sponsor open_id is caught here with a clear
    // DUPLICATE_ERROR. The lock held since step 1 makes this read-then-write safe.
    const [existing] = await em.execute<{ id: string }[]>(
      `SELECT id FROM credit_transaction
         WHERE source_transaction_id = ? AND reason = 'pack_open' AND amount < 0
           AND deleted_at IS NULL
         LIMIT 1`,
      [input.sourceTransactionId],
    );
    if (existing) {
      throw new MedusaError(
        MedusaError.Types.DUPLICATE_ERROR,
        `Open '${input.sourceTransactionId}' has already been settled.`,
      );
    }

    let txn: Awaited<ReturnType<typeof this.createCreditTransactions>>[0];
    const commissions: CommissionPaid[] = [];
    try {
      [txn] = await this.createCreditTransactions(
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

      // 5) Commission fan-out (Phase 2b: direct gen-1 + team-override gens 2..N).
      //    All inside the SAME locked txn so the debit + every commission credit +
      //    lifecycle row commit or roll back together (no saga step could share
      //    this lock — spec §3).
      // The commission basis is the EXTERNAL-FUNDED portion of this open.
      // Net basis reaches zero on clawback (reverseOpen negates externalFundedCents),
      // so the basis is NOT refund-stable at the ledger level. The monotonic
      // lifetime counter (built in a later task) is the rank basis; spec §3.
      const basisSen = -externalFundedCents;
      if (basisSen > 0) {
        const [rel] = await this.listReferralRelationships(
          { customer_id: input.customerId },
          { take: 1 },
        );
        if (rel?.sponsor_id) {
          const sponsorId = rel.sponsor_id;
          // Sponsor's effective level, derived live from THEIR external-funded
          // spend against the current ladder (forward-only config). Note:
          // creditSummary is @InjectManager (no context param) — the direct path's
          // level read stays as-is; only flat-20% overrides are added below, which
          // need no per-ancestor level read.
          const sponsorSummary = await this.creditSummary(sponsorId);
          const ladderRows = await this.listVipLevels(
            {},
            {
              select: ['level', 'spend_threshold', 'direct_referral_pct'],
              take: 1000,
            },
          );
          const levelLadder = ladderRows.map((r) => ({
            level: r.level,
            spend_threshold: Number(r.spend_threshold),
          }));
          const pctLadder = ladderRows.map((r) => ({
            level: r.level,
            direct_referral_pct: Number(r.direct_referral_pct),
          }));
          const sponsorLevel = levelForSpend(
            sponsorSummary.externalFundedSpendTotal,
            levelLadder,
          );
          const pct = directReferralPctForLevel(sponsorLevel, pctLadder);
          const commissionSen = directCommissionSen(basisSen, pct);

          if (commissionSen > 0) {
            // Thread sharedContext so the settings read runs on THIS locked txn.
            const settings = await this.rewardsSettings(sharedContext);
            const matured = settings.commissionCooldownDays === 0;
            // For cooldown=0 set matures_at to epoch so matures_at > now() is
            // definitively false even if JS clock lags Postgres transaction now().
            const maturesAt = matured
              ? new Date(0)
              : new Date(
                  Date.now() + settings.commissionCooldownDays * 86_400_000,
                );

            // Pay one beneficiary: the credit row + its 1:1 lifecycle row, in the
            // SAME locked txn. The partial-unique index (source_transaction_id,
            // reason, customer_id, generation) rejects a replayed open_id with a
            // 23505 (caught below). reason = 'direct_referral' for gen 1, else
            // 'team_override'. effective_pct snapshots the whole-percent used.
            const payCommission = async (
              beneficiary: string,
              amountSen: number,
              generation: number,
              kind: 'direct' | 'override',
              effectivePct: number,
            ): Promise<void> => {
              const [credit] = await this.createCreditTransactions(
                [
                  {
                    customer_id: beneficiary,
                    amount: amountSen / 100,
                    reason:
                      kind === 'direct' ? 'direct_referral' : 'team_override',
                    pull_id: null,
                    reference: null,
                    external_funded_cents: 0, // commission is internal, not external
                    source_transaction_id: input.sourceTransactionId,
                    generation,
                  },
                ],
                sharedContext,
              );
              await this.createCommissions(
                [
                  {
                    credit_transaction_id: credit.id,
                    beneficiary,
                    source_transaction_id: input.sourceTransactionId,
                    generation,
                    kind,
                    status: matured ? 'available' : 'pending',
                    matures_at: maturesAt,
                    effective_pct: effectivePct,
                    reversal_transaction_id: null,
                  },
                ],
                sharedContext,
              );
              commissions.push({ beneficiary, amountSen, matured });
              // NOTE: a frozen sponsor repaid only by a downline commission lifts
              // on their next direct inflow (mutateCreditAtomic holds their lock)
              // — we do NOT auto-unfreeze here: settleOpen holds only the
              // recruit's lock, so unfreezing a beneficiary would be a TOCTOU
              // race (and taking the beneficiary lock here risks deadlock vs the
              // sorted-lock reversal paths).
            };

            // gen 1 — the direct sponsor.
            await payCommission(sponsorId, commissionSen, 1, 'direct', pct);

            // gens 2..N — the team-override DAG up the sponsor's upline. Flat
            // whole-percent (team_override_pct * 100). The schedule self-
            // terminates at <1 sen; generation = absolute tree depth.
            const overridePct = Math.round(settings.teamOverridePct * 100);
            const schedule = teamOverrideSchedule(
              commissionSen,
              overridePct,
              settings.overrideGenerationCap,
            );
            if (schedule.length > 0) {
              const byDepth = new Map(
                schedule.map((s) => [s.generation, s.amountSen]),
              );
              const maxDepth = schedule[schedule.length - 1].generation;
              // Ordered ancestors ABOVE the direct sponsor, each with its absolute
              // tree depth (direct sponsor = depth 1). A NEW recursive CTE — the
              // linkSponsor query is a ≤1-row cycle PROBE, not an enumerator — that
              // carries a depth column + ORDER BY depth, bounded by the deepest
              // paid generation. customer_id is unique => simple path, terminates.
              const ancestors = await em.execute<
                { ancestor_id: string; depth: string }[]
              >(
                `WITH RECURSIVE up AS (
                   SELECT sponsor_id AS ancestor_id, 2 AS depth
                     FROM referral_relationship
                     WHERE customer_id = ? AND deleted_at IS NULL
                   UNION ALL
                   SELECT r.sponsor_id, up.depth + 1
                     FROM referral_relationship r
                     JOIN up ON r.customer_id = up.ancestor_id
                     WHERE r.deleted_at IS NULL AND up.depth < ?
                 )
                 SELECT ancestor_id, depth FROM up ORDER BY depth`,
                [sponsorId, maxDepth],
              );
              for (const anc of ancestors) {
                const amountSen = byDepth.get(Number(anc.depth));
                if (!amountSen) continue; // beyond self-termination -> no override
                await payCommission(
                  anc.ancestor_id,
                  amountSen,
                  Number(anc.depth),
                  'override',
                  overridePct,
                );
              }
              // Defensive: a real schedule self-terminates long before the cap.
              // Reaching it is an anomaly (escaped cycle / data corruption) — log,
              // do NOT abort the recruit's open.
              if (
                schedule[schedule.length - 1].generation ===
                settings.overrideGenerationCap
              ) {
                // eslint-disable-next-line no-console
                console.warn(
                  `[settleOpen] override schedule reached override_generation_cap=${settings.overrideGenerationCap}`,
                  {
                    source_transaction_id: input.sourceTransactionId,
                    recruit_id: input.customerId,
                  },
                );
              }
            }
          }
        }
      }
    } catch (e) {
      // A 23505 means this open_id already settled — from EITHER the debit index
      // (no-sponsor path, Phase 3b) or the commission index (with-sponsor path).
      // The 23505 already aborted THIS txn (25P02); re-raise as DUPLICATE_ERROR so
      // @InjectTransactionManager rolls the whole settleOpen back, DEBIT included.
      // No SAVEPOINT — that would let the duplicate debit commit.
      if (isUniqueViolation(e)) {
        throw new MedusaError(
          MedusaError.Types.DUPLICATE_ERROR,
          `Open '${input.sourceTransactionId}' has already been settled.`,
        );
      }
      throw e;
    }

    return {
      id: txn.id,
      balance: (beforeCents + deltaCents) / 100,
      commissions,
    };
  }

  // Locked (unspendable) commission credit for a customer, in cents, read inside
  // the caller's transaction. Sums the POSITIVE commission credit rows whose
  // paired lifecycle record is not yet spendable: 'pending' AND not matured
  // (matures_at > now()), OR 'suspended'. 'available' and 'reversed' are NOT
  // locked — 'available' is the post-maturity spendable state, and a 'reversed'
  // commission's positive credit is already netted by its negative reversal row
  // in the raw balance (locking it too would double-subtract). Maturity is a
  // read-time predicate on 'pending' — no scheduler can make spend wrong by
  // lagging (a matured-but-not-yet-flipped 'pending' row reads as available).
  // True if the customer is currently frozen. Read on the caller's connection so
  // it participates in the same advisory-locked transaction as the debit gate.
  private async isFrozen(
    customerId: string,
    sharedContext: Context,
  ): Promise<boolean> {
    const [row] = await this.listCustomerAccountStates(
      { customer_id: customerId, frozen: true },
      { take: 1 },
      sharedContext,
    );
    return !!row;
  }

  private async lockedCommissionCents(
    customerId: string,
    em: LedgerSqlManager,
  ): Promise<number> {
    const rows = await em.execute<{ locked_cents: string | null }[]>(
      `SELECT COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS locked_cents
         FROM credit_transaction ct
         JOIN commission c ON c.credit_transaction_id = ct.id
        WHERE ct.customer_id = ?
          AND ct.deleted_at IS NULL
          AND c.deleted_at IS NULL
          AND ct.amount > 0
          AND ((c.status = 'pending' AND c.matures_at > now()) OR c.status = 'suspended')`,
      [customerId],
    );
    return Number(rows[0]?.locked_cents ?? 0);
  }

  // Public available balance = raw balance − locked commission. The single gate
  // every locked-aware debit uses (spec §8). (Phase 3a: a frozen account returns
  // 0 here.) Read in its own short transaction.
  @InjectManager()
  async availableBalance(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<number> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const rows = await em.execute<{ balance_cents: string | null }[]>(
      'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents ' +
        'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
      [customerId],
    );
    if (await this.isFrozen(customerId, sharedContext)) return 0; // Phase 3a freeze
    const balanceCents = Number(rows[0]?.balance_cents ?? 0);
    const lockedCents = await this.lockedCommissionCents(customerId, em);
    return (balanceCents - lockedCents) / 100;
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
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `referral:${lo}`,
    ]);
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `referral:${hi}`,
    ]);

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

  // Delete-guard (spec §3 invariant 1): money rows backing a commission are
  // append-only — never hard-deleted. Compensation MUST use
  // reverseCreditTransaction. This refuses an accidental delete of any row a
  // commission lifecycle record points at.
  //
  // *** THIS IS THE ONLY PERMITTED DELETE PATH FOR credit_transaction ROWS. ***
  // Never call the base `deleteCreditTransactions` directly from workflow steps,
  // routes, or any new code — always go through this guard. The base is an
  // internal delegation detail only (see the single call below). The source-scan
  // seal test (`delete-guard-seal.unit.spec.ts`) enforces this: it reads the
  // entire src/ tree and asserts that the only occurrence of a bare
  // `.deleteCreditTransactions(` call (i.e. not `deleteCreditTransactionsGuarded`)
  // is the single delegation inside this method. Adding a new raw caller breaks CI.
  //
  // Named `deleteCreditTransactionsGuarded` rather than overriding
  // `deleteCreditTransactions` because MedusaService defines the base as an
  // **instance member property** (arrow-function assigned in the constructor), not
  // a class method. TypeScript TS2425 prevents overriding a property with a method.
  // Casting `this` to call its own `deleteCreditTransactions` would be infinite
  // recursion, so a distinct name is the correct pattern (brief §fallback).
  //
  // NOTE: selector-form (Record) deletes fall through without the guard — realistic
  // accidental deletes are by id. If selector-form bypasses matter, the caller must
  // use list → id-form to make the guard run.
  async deleteCreditTransactionsGuarded(
    idOrSelector: string | string[] | Record<string, unknown>,
  ): Promise<void> {
    const ids =
      typeof idOrSelector === 'string'
        ? [idOrSelector]
        : Array.isArray(idOrSelector)
          ? idOrSelector
          : null;
    if (ids && ids.length > 0) {
      const deps = await this.listCommissions(
        { credit_transaction_id: ids },
        { take: 1 },
      );
      if (deps.length > 0) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          'Cannot delete a credit transaction that backs a commission — reverse it instead.',
        );
      }
    }
    // Delegate to the MedusaService-generated base (property, not overridable).
    await this.deleteCreditTransactions(idOrSelector as never);
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
  // Atomic credit adjustment + audit: writes the ledger row AND the
  // admin_action_audit row in the same transaction so both commit or neither
  // does. adminId comes from the session (auth_context.actor_id) — never from
  // the request body — and is stamped on the audit row. before/after record the
  // balance values bracketing the adjustment so the row is self-explanatory.
  @InjectTransactionManager()
  async adminAdjustCredit(
    input: {
      customerId: string;
      amount: number;
      note: string;
      adminId: string;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ id: string; amount: number; balance: number }> {
    const { id, balance } = await this.mutateCreditAtomic(
      {
        customerId: input.customerId,
        amount: input.amount,
        reason: 'adjustment',
        reference: input.note,
        floor: 0,
      },
      sharedContext,
    );
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'credit',
          entity_id: id,
          action: 'adjust_credit',
          before: { balance: Number((balance - input.amount).toFixed(2)) },
          after: { balance },
          reason: input.note,
        },
      ],
      sharedContext,
    );
    return { id, amount: input.amount, balance };
  }

  // Admin edit of the rewards-settings singleton — validates+clamps the patch,
  // upserts the singleton, and writes an audit row. Public method is named
  // `editRewardsSettings` to avoid shadowing the MedusaService-generated
  // `updateRewardsSettings` CRUD method, which is called internally for the
  // upsert.
  @InjectTransactionManager()
  async editRewardsSettings(
    input: { patch: RewardsSettingsPatch; adminId: string; reason: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<RewardsSettingsView> {
    const patch = validateRewardsPatch(input.patch);
    const [row] = await this.listRewardsSettings(
      {},
      { take: 1 },
      sharedContext,
    );
    const before: RewardsSettingsView = {
      commissionCooldownDays: row ? Number(row.commission_cooldown_days) : 3,
      teamOverridePct: row ? Number(row.team_override_pct) : 0.2,
      overrideGenerationCap: row ? Number(row.override_generation_cap) : 100,
    };
    const data = {
      commission_cooldown_days:
        patch.commissionCooldownDays ?? before.commissionCooldownDays,
      team_override_pct: patch.teamOverridePct ?? before.teamOverridePct,
      override_generation_cap:
        patch.overrideGenerationCap ?? before.overrideGenerationCap,
    };
    if (row) {
      await this.updateRewardsSettings(
        { selector: { id: row.id }, data },
        sharedContext,
      );
    } else {
      await this.createRewardsSettings([data], sharedContext);
    }
    const after: RewardsSettingsView = {
      commissionCooldownDays: data.commission_cooldown_days,
      teamOverridePct: data.team_override_pct,
      overrideGenerationCap: data.override_generation_cap,
    };
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'rewards_settings',
          entity_id: row?.id ?? 'singleton',
          action: 'edit_rewards_settings',
          before,
          after,
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return after;
  }

  // Monotonic lifetime external spend for a single customer, in SEN. Sums
  // ORIGINAL pack_open debits (amount<0) only — reversals are amount>0 and
  // thus excluded, so the counter never drops on a clawback (spec §3).
  // This mirrors the `lifetimeExternalSen` pure fold but runs in raw SQL for
  // efficiency (one scan vs. N ORM fetches). Uses @InjectManager so a caller
  // outside a transaction gets a fresh connection.
  @InjectManager()
  async lifetimeExternalSenFor(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<number> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const rows = await em.execute<{ sen: string | null }[]>(
      `SELECT COALESCE(SUM(-external_funded_cents), 0)::bigint AS sen
         FROM credit_transaction
        WHERE customer_id = ? AND reason = 'pack_open' AND amount < 0 AND deleted_at IS NULL`,
      [customerId],
    );
    return Number(rows[0]?.sen ?? 0);
  }

  // Race-free upsert of the vip_member_state projection row. Uses
  // INSERT … ON CONFLICT(customer_id) DO UPDATE so concurrent rebuilds for the
  // same customer always converge. GREATEST ensures highest_level_ever is truly
  // monotonic (never regressed by a concurrent rebuild off a different snapshot).
  @InjectManager()
  async upsertVipMemberState(
    input: {
      customerId: string;
      lifetimeSen: number;
      highestLevelEver: number;
      currentLevel: number;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    await em.execute(
      `INSERT INTO vip_member_state
         (id, customer_id, lifetime_external_spend_sen, highest_level_ever, current_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, now(), now())
       ON CONFLICT (customer_id) WHERE deleted_at IS NULL DO UPDATE SET
         lifetime_external_spend_sen = EXCLUDED.lifetime_external_spend_sen,
         highest_level_ever = GREATEST(vip_member_state.highest_level_ever, EXCLUDED.highest_level_ever),
         current_level = EXCLUDED.current_level,
         updated_at = now()`,
      [
        `vms_${input.customerId}`,
        input.customerId,
        input.lifetimeSen,
        input.highestLevelEver,
        input.currentLevel,
      ],
    );
  }

  // Rebuild the vip_member_state projection for a single customer from the
  // authoritative ledger. Safe to call repeatedly — the upsert is idempotent.
  // lifetime uses the monotonic counter (fromSen for levelForSpend unit conversion);
  // current_level uses the net-basis summary (may drop on refund).
  async rebuildVipMemberState(
    customerId: string,
    sharedContext: Context = {},
  ): Promise<void> {
    const lifetimeSen = await this.lifetimeExternalSenFor(
      customerId,
      sharedContext,
    );
    const netBasisMyr = (await this.creditSummary(customerId))
      .externalFundedSpendTotal;
    const ladderRows = await this.listVipLevels(
      {},
      { select: ['level', 'spend_threshold'], take: 1000 },
    );
    const ladder = ladderRows.map((r) => ({
      level: r.level,
      spend_threshold: Number(r.spend_threshold),
    }));
    await this.upsertVipMemberState(
      {
        customerId,
        lifetimeSen,
        highestLevelEver: levelForSpend(fromSen(lifetimeSen), ladder), // fromSen: SEN→MYR unit conversion (UNIT TRAP)
        currentLevel: levelForSpend(netBasisMyr, ladder),
      },
      sharedContext,
    );
  }

  // Rebuild the vip_member_state projection for every customer that has ever
  // touched the credit ledger. Intended for admin-triggered full reconciliation.
  @InjectManager()
  async rebuildAllVipMemberState(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const customers = await em.execute<{ customer_id: string }[]>(
      `SELECT DISTINCT customer_id FROM credit_transaction WHERE deleted_at IS NULL`,
      [],
    );
    for (const row of customers) {
      await this.rebuildVipMemberState(row.customer_id, sharedContext);
    }
  }

  // Grant ladder rewards for every newly-crossed VIP level (Phase 3b §E).
  //
  // Monotonic-grant invariant: derives the trigger level from the MONOTONIC
  // lifetime counter (lifetimeExternalSenFor → fromSen → levelForSpend) so
  // a clawback+respend can never re-grant rewards already earned. The high-water
  // mark (highest_level_ever) is read from the existing state row (default L1)
  // and drives levelsToGrant — L1 is never granted (levelsToGrant enforces L2 floor).
  //
  // Grant insert idempotency: uses raw INSERT … ON CONFLICT (customer_id, level, kind)
  // WHERE deleted_at IS NULL DO NOTHING so a replayed event with the same
  // (customerId, openId) simply skips existing rows without raising a 23505. A
  // try/catch around the ORM's createVipRewardGrants would poison the enclosing
  // txn (Postgres 25P02) on the first duplicate — raw DO NOTHING avoids this
  // entirely. The partial WHERE clause must match the UQ_vip_reward_grant_customer_level_kind
  // partial index (defined in vip-reward-grant.ts with `where: 'deleted_at IS NULL'`).
  //
  // currentLevel uses the NET basis (creditSummary.externalFundedSpendTotal) so
  // it may drop below highest_level_ever after a clawback — that's by design.
  @InjectManager()
  async grantLevelUpRewards(
    customerId: string,
    openId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ gained: number[] }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;

    // 1) Recompute from ledger so redelivery is always idempotent.
    const lifetimeSen = await this.lifetimeExternalSenFor(
      customerId,
      sharedContext,
    );
    // UNIT TRAP: lifetimeSen is integer sen, levelForSpend expects MYR. Convert.
    const lifetimeMyr = fromSen(lifetimeSen);

    // 2) Net basis for display-level (separate axis from grant trigger).
    const netBasisMyr = (await this.creditSummary(customerId))
      .externalFundedSpendTotal;

    // 3) Load the full ladder for both level derivation and reward lookup.
    const ladderRows = await this.listVipLevels(
      {},
      {
        select: [
          'level',
          'spend_threshold',
          'voucher_amount',
          'box_tier',
          'frame_unlock',
        ],
        take: 1000,
      },
    );
    const thresholdRows = ladderRows.map((r) => ({
      level: r.level,
      spend_threshold: Number(r.spend_threshold),
    }));
    const byLevel = new Map(ladderRows.map((r) => [r.level, r]));

    // 4) High-water mark from existing state row (default L1 if no row yet).
    const [existingState] = await this.listVipMemberStates(
      { customer_id: customerId },
      { take: 1 },
    );
    const highestEver = existingState
      ? Number(existingState.highest_level_ever)
      : 1;

    // 5) Derive the new monotonic level. Clawback keeps lifetime unchanged,
    //    so newLevel never regresses even after reverseOpen.
    const newLevel = levelForSpend(lifetimeMyr, thresholdRows);

    // 6) Grant rewards for each newly-crossed level (L2+).
    const gained: number[] = [];
    for (const L of levelsToGrant(highestEver, newLevel)) {
      const row = byLevel.get(L);
      if (!row) continue;
      const rewards = rewardsForLevel({
        level: row.level,
        voucher_amount: Number(row.voucher_amount),
        box_tier: row.box_tier,
        frame_unlock: row.frame_unlock,
      });
      for (const reward of rewards) {
        // Raw INSERT … ON CONFLICT … DO NOTHING — avoids 23505 poisoning the txn
        // (Postgres 25P02). The ON CONFLICT predicate MUST match the partial index
        // UQ_vip_reward_grant_customer_level_kind (where: 'deleted_at IS NULL').
        // Deterministic id: vrg_<customerId>_<level>_<kind> for deduplication.
        const grantId = `vrg_${customerId}_${L}_${reward.kind}`;
        await em.execute(
          `INSERT INTO vip_reward_grant
             (id, customer_id, level, kind, payload, status, source_open_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?::jsonb, 'granted', ?, now(), now())
           ON CONFLICT (customer_id, level, kind) WHERE deleted_at IS NULL DO NOTHING`,
          [
            grantId,
            customerId,
            L,
            reward.kind,
            JSON.stringify(reward.payload),
            openId,
          ],
        );
      }
      gained.push(L);
    }

    // 7) Upsert state: GREATEST guard in upsertVipMemberState ensures
    //    highest_level_ever never regresses even under concurrent rebuilds.
    const newHighest = Math.max(highestEver, newLevel);
    const currentLevel = levelForSpend(netBasisMyr, thresholdRows);
    await this.upsertVipMemberState(
      {
        customerId,
        lifetimeSen,
        highestLevelEver: newHighest,
        currentLevel,
      },
      sharedContext,
    );

    return { gained };
  }

  // Maturity job (Phase 3b Task 7): flips pending commissions whose cooldown has
  // elapsed (matures_at <= now) to 'available' so the status column stays in sync
  // with the read-time availableBalance gate. This is COSMETIC/AUDIT only — the
  // balance gate already treats a pending row as available once matures_at passes,
  // so this flip never changes spendability.
  //
  // Per-beneficiary: acquires the credit: advisory lock (same keyspace as
  // mutateCreditAtomic / settleOpen) so concurrent reversal writes on the same
  // beneficiary are serialized. Uses SKIP LOCKED chunked UPDATEs so a second
  // concurrent run skips already-locked rows rather than blocking.
  //
  // Status-guarded (status='pending' in WHERE) → idempotent, never clobbers
  // reversed/suspended rows.
  @InjectTransactionManager()
  async matureDueCommissions(
    notify?: (
      beneficiaryId: string,
      commissionId: string,
      frozen: boolean,
    ) => Promise<void>,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ flipped: number }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const CHUNK = 500;

    // 1) Enumerate all distinct beneficiaries that have at least one due pending row.
    const due = await em.execute<{ beneficiary: string }[]>(
      `SELECT DISTINCT beneficiary FROM commission
        WHERE status = 'pending' AND matures_at <= now() AND deleted_at IS NULL
        ORDER BY beneficiary`,
    );

    let flipped = 0;

    for (const { beneficiary } of due) {
      // 2) Acquire per-beneficiary advisory lock (same credit: keyspace used by
      //    mutateCreditAtomic, settleOpen, reverseCommission, reverseOpen).
      //    Transaction-scoped — auto-releases on commit/rollback.
      await em.execute(
        'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
        [`credit:${beneficiary}`],
      );

      // 3) Check freeze state inside the lock so the flag is consistent with
      //    the advisory-locked read (isFrozen reads on sharedContext's connection).
      const frozen = await this.isFrozen(beneficiary, sharedContext);

      // 4) Chunked flip: Postgres rejects LIMIT on a bare UPDATE, so use a
      //    sub-select with FOR UPDATE SKIP LOCKED + RETURNING. Loop until the
      //    batch returns fewer than CHUNK rows (i.e. no more to process).
      for (;;) {
        const rows = await em.execute<{ id: string }[]>(
          `UPDATE commission
              SET status = 'available', updated_at = now()
            WHERE id IN (
              SELECT id FROM commission
               WHERE beneficiary = ?
                 AND status = 'pending'
                 AND matures_at <= now()
                 AND deleted_at IS NULL
               ORDER BY matures_at
               LIMIT ?
               FOR UPDATE SKIP LOCKED
            )
            RETURNING id`,
          [beneficiary, CHUNK],
        );

        for (const r of rows) {
          flipped++;
          if (notify) await notify(beneficiary, r.id, frozen);
        }

        if (rows.length < CHUNK) break;
      }
    }

    return { flipped };
  }
}

export default PacksModuleService;
