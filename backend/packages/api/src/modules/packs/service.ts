import { randomInt } from 'node:crypto';
import {
  MedusaService,
  MedusaError,
  InjectManager,
  InjectTransactionManager,
  MedusaContext,
  Modules,
} from '@medusajs/framework/utils';
import type { Context, HttpTypes } from '@medusajs/framework/types';
import type { OddsRarity } from '@acme/odds-math';
import { validateDeliveryRequest, snapshotAddress } from './delivery';
import { rewardsRedemptionEnabled } from './rewards-gate';
import { FRAME_LEVELS } from './avatar-frames';
import Pack from './models/pack';
import Card from './models/card';
import CardPriceHistory from './models/card-price-history';
import FxRate from './models/fx-rate';
import PackOdds from './models/pack-odds';
import Pull from './models/pull';
import CreditTransaction from './models/credit-transaction';
import DeliveryOrder from './models/delivery-order';
import DeliveryOrderItem from './models/delivery-order-item';
import VipLevel from './models/vip-level';
import RewardsSettings from './models/rewards-settings';
import SiteSettings from './models/site-settings';
import ReferralRelationship from './models/referral-relationship';
import Commission from './models/commission';
import CustomerAccountState from './models/customer-account-state';
import AdminActionAudit from './models/admin-action-audit';
import VipMemberState from './models/vip-member-state';
import VipRewardGrant from './models/vip-reward-grant';
import NotificationRead from './models/notification-read';
import RewardDraw from './models/reward-draw';
import RewardBox from './models/reward-box';
import RewardBoxPrize from './models/reward-box-prize';
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
  DEFAULT_MARKET_MULTIPLIER,
  resolveFxRate,
  DEFAULT_USD_MYR,
  effectiveRate,
} from './pricing';
import {
  validateRewardsPatch,
  type RewardsSettingsPatch,
  type RewardsSettingsView,
} from './rewards-settings-validate';
import {
  validateDailyBox,
  computeBoxWeights,
  pickPrize,
  MAX_BOX_CREDIT_MYR,
  type DailyBoxBody,
  type BoxPrizeInput,
} from './daily-box';
import { foldRanges, type VoucherRange } from './voucher-ranges';
import { getCardStockByHandle } from './card-stock';
import type { MedusaContainer } from '@medusajs/framework/types';

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
  | 'cashout'
  | 'voucher_claim'
  | 'reward_credit'
  | 'daily_reward';

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
  /**
   * When set, the insert is IDEMPOTENT on this reference under the per-customer
   * advisory lock: if a row already carries it, that row is returned unchanged
   * instead of appending a second credit (top-up replay protection — security
   * audit 2026-06-23). The stored `reference` becomes this value. Mirrors the
   * `reversal:${id}` locked-dedupe used by reverseCreditTransaction; no DB
   * unique needed — the lock serializes check-then-insert per customer.
   */
  idempotencyReference?: string | null;
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

/** Phase 4 P4.1 — Admin referral tree node (read-only, zero migrations). */
export type PacksTreeNode = {
  customer_id: string;
  depth: number; // root = 0; direct recruits = 1
  sponsor_id: string | null;
  vip_level: number | null;
  lifetime_external_spend_sen: string;
  frozen: boolean;
  direct_recruit_count: number;
  has_more_depth: boolean; // depth === maxDepth && direct_recruit_count > 0
};

/** Phase 4 P4.1 — commission row returned by commissionsForBeneficiary (read-only). */
export type CommissionRow = {
  id: string;
  generation: number;
  kind: 'direct' | 'override';
  status: 'pending' | 'available' | 'suspended' | 'reversed';
  amount: string;
  reason: 'direct_referral' | 'team_override';
  matures_at: string;
  reversal_transaction_id: string | null;
  source_transaction_id: string;
  opener_customer_id: string | null;
  created_at: string;
};

/** Phase 4 P4.2 — admin audit timeline row (read-only, zero migrations). */
export type AuditRow = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  before: any;
  after: any;
  reason: string | null;
  created_at: string;
  admin_id: string;
};

/** The transactional MikroORM manager surface we use for the advisory lock +
 *  the Σ-ledger read. `?` placeholders are inlined by MikroORM's formatQuery. */
type LedgerSqlManager = {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
};

// ---- Daily Rewards (Task 5): getDailyState / drawDailyBox + admin authoring ----
// Types match the task-5 brief verbatim — later tasks (routes, storefront) depend
// on these exact shapes.

/** A VIP reward grant projected for a store-facing list (no internal fields). */
export type GrantView = {
  id: string;
  kind: 'voucher' | 'frame';
  level: number;
  payload: unknown;
  granted_at: string;
  /** 'ladder' = one-time level-up reward; 'box' = won from a daily box. */
  origin: 'ladder' | 'box';
};

/** A vaulted reward-prize Pull, same shape as the old GET /store/rewards `prizes`. */
export type PrizeView = {
  pull_id: string;
  prize_kind: string;
  prize_snapshot: unknown;
  status: string;
  draw_day: string;
};

export type DailyState = {
  redemption_enabled: boolean;
  box: null | {
    tier: string;
    name: string;
    draws_per_day: number;
    draws_today: number;
    next_reset: string;
    prizes: {
      kind: string;
      title?: string;
      image?: string;
      amount_myr?: number;
    }[];
  };
  vouchers: { claimable: GrantView[]; claimed: GrantView[] };
  ship_prizes: PrizeView[];
};

export type DrawDailyBoxResult = {
  status: 'drawn' | 'unavailable' | 'capped';
  prize?: {
    kind: string;
    title?: string;
    image?: string;
    amount_myr?: number;
    product_handle?: string;
  };
  draw_ordinal?: number;
};

// Defensive depth bound for referralSummary's downward fan-out CTE. linkSponsor
// already rejects cycles, so a real tree terminates well before this; the cap
// is belt-and-suspenders against a corrupted edge so COUNT(*) can never loop.
const DOWNSTREAM_DEPTH_CAP = 100;

class PacksModuleService extends MedusaService({
  Pack,
  Card,
  CardPriceHistory,
  FxRate,
  PackOdds,
  Pull,
  CreditTransaction,
  DeliveryOrder,
  DeliveryOrderItem,
  VipLevel,
  RewardsSettings,
  SiteSettings,
  ReferralRelationship,
  Commission,
  CustomerAccountState,
  AdminActionAudit,
  VipMemberState,
  VipRewardGrant,
  NotificationRead,
  RewardDraw,
  RewardBox,
  RewardBoxPrize,
}) {
  // Apply a pack-membership diff (add rows + delete rows + renormalize
  // survivor weights) as ONE transaction. The set-pack-members workflow step
  // computes the diff; a failed step never runs its OWN compensation, so
  // without this the pool could be left half-migrated (e.g. adds committed,
  // removals not) by a mid-diff crash. All three writes share the injected
  // txn and roll back together.
  @InjectTransactionManager()
  async applyPackMemberDiff(
    diff: {
      pack_id: string;
      create: {
        pack_id: string;
        card_id: string;
        rarity: OddsRarity;
        weight: number;
        locked: boolean;
      }[];
      remove_ids: string[];
      reweigh: { id: string; weight: number }[];
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ created_ids: string[] }> {
    // The diff was computed from a PRE-transaction read, so two racing edits
    // on the same pack could both apply stale diffs (worst case: the same
    // card created twice, silently doubling its draw weight). Serialize per
    // pack (same advisory-lock pattern as the per-customer credit lock), then
    // re-validate the stale diff against a fresh read UNDER the lock — the
    // lock alone would serialize the writes but not fix the stale reads.
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `pack:${diff.pack_id}`,
    ]);
    const current = await this.listPackOdds(
      { pack_id: diff.pack_id },
      { take: 1000 },
      sharedContext,
    );
    const presentCards = new Set(current.map((o) => o.card_id));
    const presentIds = new Set(current.map((o) => o.id));
    const create = diff.create.filter((c) => !presentCards.has(c.card_id));
    const remove_ids = diff.remove_ids.filter((id) => presentIds.has(id));
    const reweigh = diff.reweigh.filter((u) => presentIds.has(u.id));

    const created = create.length
      ? await this.createPackOdds(create, sharedContext)
      : [];
    if (remove_ids.length) {
      await this.deletePackOdds(remove_ids, sharedContext);
    }
    if (reweigh.length) {
      await this.updatePackOdds(reweigh, sharedContext);
    }
    return { created_ids: created.map((c) => c.id) };
  }

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
    withdrawals_per_day: number;
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
      withdrawals_per_day: row ? Number(row.withdrawals_per_day) : 1,
    };
  }

  // Storefront presentation globals. Reads the singleton row; falls back to
  // defaults when absent (null slab frame → storefront bundles its own;
  // avatar_frames → {} until the admin uploads milestone frames).
  @InjectManager()
  async siteSettings(@MedusaContext() sharedContext: Context = {}): Promise<{
    slab_frame_url: string | null;
    avatar_frames: Record<string, string>;
  }> {
    const [row] = await this.listSiteSettings({}, { take: 1 }, sharedContext);
    return {
      slab_frame_url: row?.slab_frame_url ?? null,
      // Cleared levels are persisted as explicit nulls (see editAvatarFrames)
      // — filter them out so consumers only ever see level → URL strings.
      avatar_frames: Object.fromEntries(
        Object.entries(
          (row?.avatar_frames as Record<string, string | null> | null) ?? {},
        ).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string';
        }),
      ),
    };
  }

  // Admin edit of the site-settings singleton — upserts and writes an audit
  // row. Named `editSiteSettings` to avoid shadowing the MedusaService-
  // generated `updateSiteSettings` CRUD method (same convention as
  // editRewardsSettings).
  @InjectTransactionManager()
  async editSiteSettings(
    input: {
      slabFrameUrl: string | null;
      adminId: string;
      reason: string;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ slab_frame_url: string | null }> {
    const [row] = await this.listSiteSettings({}, { take: 1 }, sharedContext);
    const before = { slab_frame_url: row?.slab_frame_url ?? null };
    const data = { slab_frame_url: input.slabFrameUrl };
    if (row) {
      await this.updateSiteSettings(
        { selector: { id: row.id }, data },
        sharedContext,
      );
    } else {
      // Fixed id — the DB CHECK ("id" = 'global') enforces the singleton, so
      // a create race can never leave two rows.
      await this.createSiteSettings([{ id: 'global', ...data }], sharedContext);
    }
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'site_settings',
          entity_id: row?.id ?? 'singleton',
          action: 'edit_site_settings',
          before,
          after: data,
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return data;
  }

  // Admin edit of the avatar-frame catalog — upsert + audit, same discipline
  // as editSiteSettings (which owns slab_frame_url; this method never touches
  // it and vice versa).
  @InjectTransactionManager()
  async editAvatarFrames(
    input: {
      frames: Record<string, string>;
      adminId: string;
      reason: string;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ avatar_frames: Record<string, string> }> {
    const [row] = await this.listSiteSettings({}, { take: 1 }, sharedContext);
    const before = {
      avatar_frames:
        (row?.avatar_frames as Record<string, string> | null) ?? {},
    };
    // The ORM MERGES json columns on update (an omitted key survives a
    // "replace" — caught by the null-clear http test), so persist every
    // milestone key explicitly: null overwrites a stale entry. Reads
    // (siteSettings) filter the nulls back out.
    const full: Record<string, string | null> = {};
    for (const level of FRAME_LEVELS) {
      full[String(level)] = input.frames[String(level)] ?? null;
    }
    const data = { avatar_frames: full };
    if (row) {
      await this.updateSiteSettings(
        { selector: { id: row.id }, data },
        sharedContext,
      );
    } else {
      await this.createSiteSettings(
        [{ id: 'global', slab_frame_url: null, ...data }],
        sharedContext,
      );
    }
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'site_settings',
          entity_id: row?.id ?? 'global',
          action: 'edit_avatar_frames',
          before,
          after: data,
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    // Public shape: only configured levels, never the null placeholders.
    return { avatar_frames: input.frames };
  }

  // The instant/flat sell-back offer for a pull, composed from the SAME pure
  // helpers the buyback workflow credits with — so the reveal quote, the vault
  // quote, and the credit can never disagree. Removes the listPacks +
  // resolveBuybackRate re-query the open route did inline.
  async quoteBuyback(
    packSlug: string,
    pull: { rolled_at: Date | string; revealed_at?: Date | string | null },
    // The MYR display Value (raw USD × FX × per-card markup), NOT raw USD —
    // buyback pays MYR credits, so the percent is of what the customer sees.
    valueMyr: number,
    nowMs: number = Date.now(),
  ): Promise<{
    percent: number;
    amount: number;
    rate_type: BuybackRate['rate_type'];
  }> {
    const [pack] = await this.listPacks({ slug: packSlug }, { take: 1 });
    const { percent, rate_type } = resolveBuybackRate(pack, pull, nowMs);
    return { percent, amount: buybackAmount(valueMyr, percent), rate_type };
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
  ): Promise<{
    id: string;
    balance: number;
    amount: number;
    replayed: boolean;
  }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;

    // 1) Serialize all credit mutations for THIS customer on the locked txn.
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${input.customerId}`,
    ]);

    // 1a) Idempotent replay (top-up): under the lock, if a row already carries
    // this idempotency reference the request already applied — return it as a
    // no-op rather than appending a second credit. The lock makes the
    // check-then-insert atomic per customer, so concurrent identical-key
    // requests can't both insert (same guarantee as reverseCreditTransaction's
    // `reversal:` dedupe — no DB unique required).
    if (input.idempotencyReference) {
      // The idempotency anchor is stored in source_transaction_id (NOT reference)
      // so the public `reference` column stays free to hold the gateway/charge
      // reference for reconciliation + refunds (CodeRabbit). Scope the dedupe to
      // THIS customer: the advisory lock above is per customer, so the check-then-
      // insert is only atomic within one customer; customer_id also makes the
      // lookup index-assisted (IDX_credit_transaction_customer_id_created_at)
      // instead of a full ledger scan.
      const [existing] = await this.listCreditTransactions(
        {
          customer_id: input.customerId,
          source_transaction_id: input.idempotencyReference,
        },
        { take: 1 },
      );
      if (existing) {
        const balRows = await em.execute<{ balance_cents: string | null }[]>(
          'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents ' +
            'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
          [input.customerId],
        );
        return {
          id: existing.id,
          balance: Number(balRows[0]?.balance_cents ?? 0) / 100,
          amount: Number(existing.amount),
          replayed: true,
        };
      }
    }

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
          // `reference` keeps the gateway/charge ref (or plain note) for
          // reconciliation; the idempotency anchor lives in source_transaction_id
          // (the dedupe target above) so the two never clobber each other.
          reference: input.reference ?? null,
          external_funded_cents: externalFundedCents,
          source_transaction_id:
            input.idempotencyReference ?? input.sourceTransactionId ?? null,
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

    return {
      id: txn.id,
      balance: (beforeCents + deltaCents) / 100,
      amount: deltaCents / 100,
      replayed: false,
    };
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
  // back to >= 0. projectedBalanceCents is the post-inflow balance: the inline
  // caller (mutateCreditAtomic) passes committed snapshot + just-inserted delta
  // (it can't re-read — MikroORM UoW buffers until flush, so a raw SQL read inside
  // the same txn would NOT see the new row); the out-of-band caller
  // (maybeAutoUnfreezeForCustomer, used by buyback) passes a fresh post-commit
  // re-read under the same lock. A MANUAL freeze is never auto-lifted. SYSTEM
  // event — recorded on the state row, NOT in admin_action_audit.
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

  // Auto-clear an AUTO freeze after a positive inflow written OUTSIDE
  // mutateCreditAtomic (the buyback step inserts its credit directly, with a
  // UNIQUE pull_id duplicate guard + clean error mapping that the generic
  // mutate path would lose). Takes the SAME per-customer advisory lock and
  // re-reads the committed balance, so it's race-safe against concurrent
  // mutations and idempotent — calling it after the credit has committed lifts
  // an AUTO freeze whose debt is now repaid, the same as mutateCreditAtomic's
  // inline unfreeze. No-op when not frozen or still negative. (F1)
  @InjectTransactionManager()
  async maybeAutoUnfreezeForCustomer(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);
    const rows = await em.execute<{ balance_cents: string | null }[]>(
      'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents ' +
        'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
      [customerId],
    );
    await this.maybeAutoUnfreeze(
      customerId,
      Number(rows[0]?.balance_cents ?? 0),
      sharedContext,
    );
  }

  // Block value-extraction for a MANUALLY frozen account (security audit
  // 2026-06-30, Batch A item 5). A *manual* freeze is the admin/AMLA/fraud hold —
  // "this account is locked, no transactions" — so it must stop value flowing OUT
  // (buyback, reward draw, voucher claim, prize withdrawal). An *auto* freeze is a
  // DIFFERENT mechanism: it marks a negative balance from a clawback and clears
  // itself once a repaying inflow — a top-up OR a buyback sale — brings the
  // balance back to >= 0 (maybeAutoUnfreeze). Gating auto freezes here would block
  // that very repayment path and strand the account in debt, so the block is
  // scoped to cause='manual'. Deliberately NOT wired into mutateCreditAtomic
  // either — that path carries top-ups and admin adjustments, which must stay
  // allowed. Each payout site calls this under its own per-customer credit: lock
  // so the read is consistent; the buyback STEP calls it bare (fresh read) before
  // crediting. @InjectManager runs it standalone or threads a caller's locked txn
  // (sharedContext). Pack OPENS are self-spend (floor-checked) and NOT gated here.
  @InjectManager()
  async assertNotFrozen(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const [state] = await this.listCustomerAccountStates(
      { customer_id: customerId, frozen: true, cause: 'manual' },
      { take: 1 },
      sharedContext,
    );
    if (state) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'This account is frozen. Please contact support before transacting.',
      );
    }
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
    // PAGED — a full reversal must never silently truncate. A bare take:1000
    // would leave the commissions of a large open (many generations) unreversed,
    // so sponsors keep clawed-back credit AND the auto-freeze projection below is
    // computed on a partial set. Mirrors reverseOpen's loop on the same key.
    const PAGE = 1000;
    const allRows = await this.listCreditTransactions(
      { source_transaction_id: open },
      { skip: 0, take: PAGE, order: { created_at: 'ASC', id: 'ASC' } },
    );
    // Append in place (push, not concat) so paging stays O(n), not O(n²). The
    // `=== skip` guard is exact: each fetch takes AT MOST PAGE rows, so the
    // accumulated length equals skip iff the last page was full (more to fetch)
    // and is strictly less on the final partial/empty page (stop) — it can never
    // exceed skip, so this never loops forever nor stops early.
    for (let skip = PAGE; allRows.length === skip; skip += PAGE) {
      const next = await this.listCreditTransactions(
        { source_transaction_id: open },
        { skip, take: PAGE, order: { created_at: 'ASC', id: 'ASC' } },
      );
      allRows.push(...next);
    }
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

  // Claim an earned VIP reward grant (B5). Read-then-write under the per-customer
  // `credit:` advisory lock, in ONE transaction (same discipline as
  // reverseCommission): re-read the grant under the lock; if it's not owned by
  // the caller or no longer `granted`, return {claimed:false} (idempotent no-op —
  // a double-click or replay can't double-credit). A VOUCHER grant credits
  // +payload.amount_myr via mutateCreditAtomic with reason 'voucher_claim',
  // external_funded_cents=0 (basis-neutral — never bumps the VIP spend basis),
  // idempotent on `voucher:<grantId>`, then flips status='fulfilled'. A FRAME
  // grant flips status only (no payout). mutateCreditAtomic re-acquires the SAME
  // credit: lock on the threaded sharedContext (re-entrant within this txn).
  @InjectTransactionManager()
  async claimReward(
    customerId: string,
    grantId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    claimed: boolean;
    kind: string;
    amount_myr?: number;
    level?: number;
  }> {
    // Defense-in-depth (spec §6): the route already 403s when the gate is off,
    // but fail closed at the mint site too so every present/future caller is safe.
    if (!rewardsRedemptionEnabled()) {
      return { claimed: false, kind: '' };
    }

    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;

    // Serialize against any concurrent credit mutation for THIS customer; the
    // re-read below then sees a consistent grant status (no double-claim race).
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);

    // Frozen accounts cannot draw value out (Batch A item 5) — block this payout
    // under the same lock as the read below.
    await this.assertNotFrozen(customerId, sharedContext);

    // Re-read the grant UNDER the lock, scoped to the owning customer.
    const [grant] = await this.listVipRewardGrants(
      { id: grantId, customer_id: customerId },
      { take: 1 },
      sharedContext,
    );
    if (!grant || grant.status !== 'granted') {
      return { claimed: false, kind: grant?.kind ?? '' };
    }

    let amountMyr: number | undefined;
    if (grant.kind === 'voucher') {
      amountMyr = Number(
        (grant.payload as { amount_myr?: number } | null)?.amount_myr ?? 0,
      );
      // ext=0 (basis-neutral); idempotent on the grant id so a replay that
      // somehow reaches the credit step before the status flip still no-ops.
      await this.mutateCreditAtomic(
        {
          customerId,
          amount: amountMyr,
          reason: 'voucher_claim',
          idempotencyReference: `voucher:${grantId}`,
        },
        sharedContext,
      );
    }

    // Flip the grant to fulfilled in the same txn (voucher + frame both).
    await this.updateVipRewardGrants(
      { selector: { id: grantId }, data: { status: 'fulfilled' } },
      sharedContext,
    );

    return {
      claimed: true,
      kind: grant.kind,
      ...(amountMyr !== undefined && { amount_myr: amountMyr }),
      level: grant.level,
    };
  }

  // Ship a vaulted reward-prize Pull as a physical delivery (B7). Mirrors
  // settleRewardDraw's discipline (read-then-write under the per-customer `credit:`
  // advisory lock in ONE transaction) — NOT the lockless requestDeliveryStep,
  // because the daily withdrawal cap is a COUNT-then-INSERT that must be atomic per
  // customer per day. The Pull.status flip vaulted → delivering under the same lock
  // (not the per-(order,pull) unique) is the one-active-shipment enforcer: a
  // concurrent second withdrawal of the same Pull re-reads it as 'delivering' and
  // returns 'invalid'.
  //
  // Returns:
  //   'requested' — order + item created, Pull flipped.
  //   'invalid'   — Pull not source='reward', not owned, or not 'vaulted'
  //                 (also: missing required shipping fields on the address).
  //   'capped'    — today's is_reward delivery_order count already hit
  //                 withdrawals_per_day.
  @InjectTransactionManager()
  async recordRewardWithdrawal(
    customerId: string,
    pullId: string,
    address: Partial<HttpTypes.StoreCustomerAddress>,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ status: 'requested' | 'capped' | 'invalid' }> {
    // Defense-in-depth (spec §13): the route 403s when the global gate is off,
    // but fail closed here too so every present/future caller stays dark until
    // redemption launches. A withdrawal ships a prize that should not exist while
    // the economy is dormant, so it is gated alongside claim + draw.
    if (!rewardsRedemptionEnabled()) {
      return { status: 'invalid' };
    }

    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;

    // 0) Serialize against any concurrent credit/withdrawal mutation for THIS
    //    customer — held across the validation, the cap COUNT, and the writes.
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);

    // Frozen accounts cannot draw value out (Batch A item 5) — block shipping a
    // prize under the same lock as the cap COUNT + writes below.
    await this.assertNotFrozen(customerId, sharedContext);

    // 1) Re-read the Pull UNDER the lock and validate it via the same pure helper
    //    the lockless delivery path uses. 'reward_source' = owned + vaulted +
    //    source='reward' — the exact shape this path ships. Any other verdict
    //    (including 'ok', which means a NON-reward pull) is invalid here: only
    //    reward prizes ship via this B7 path.
    const [pull] = await this.listPulls(
      { id: pullId },
      { take: 1 },
      sharedContext,
    );
    const verdict = validateDeliveryRequest(
      pull ? [pull] : [],
      [pullId],
      customerId,
    );
    if (verdict !== 'reward_source') {
      return { status: 'invalid' };
    }

    // 2) Snapshot the shipping address (denormalized at request time). A missing
    //    required field is a bad request, surfaced here as 'invalid' (the route
    //    has already resolved + ownership-checked the address upstream).
    const snapshot = snapshotAddress(address);
    if (!snapshot) {
      return { status: 'invalid' };
    }

    // 3) Daily-cap COUNT under the lock: today's is_reward delivery orders for
    //    this customer. DeliveryOrder has no draw_day column, so we key the day
    //    on created_at — but on the SAME UTC boundary settleRewardDraw uses
    //    (new Date().toISOString().slice(0,10)), NOT Postgres CURRENT_DATE (which
    //    is the DB session TZ). (created_at AT TIME ZONE 'UTC')::date compares the
    //    stored timestamptz in UTC against that JS-computed UTC day string, so the
    //    draw cap and the withdrawal cap roll over at the same instant. The lock
    //    makes COUNT-then-INSERT atomic per customer.
    const utcDay = new Date().toISOString().slice(0, 10);
    const { withdrawals_per_day } = await this.rewardsSettings(sharedContext);
    const countRows = await em.execute<{ n: string | null }[]>(
      `SELECT COUNT(*) AS n FROM delivery_order
         WHERE customer_id = ? AND is_reward = TRUE
           AND (created_at AT TIME ZONE 'UTC')::date = ?::date AND deleted_at IS NULL`,
      [customerId, utcDay],
    );
    if (Number(countRows[0]?.n ?? 0) >= withdrawals_per_day) {
      return { status: 'capped' };
    }

    // 4) Create the order + item, then flip the Pull under the lock. All three
    //    writes share the locked txn, so @InjectTransactionManager rolls them back
    //    together if any throws — no manual undo dance (unlike requestDeliveryStep,
    //    which has no surrounding transaction).
    const [order] = await this.createDeliveryOrders(
      [
        {
          customer_id: customerId,
          status: 'requested' as const,
          is_reward: true,
          ...snapshot,
        },
      ],
      sharedContext,
    );
    await this.createDeliveryOrderItems(
      [{ delivery_order_id: order.id, pull_id: pullId }],
      sharedContext,
    );
    await this.updatePulls(
      { selector: { id: pullId }, data: { status: 'delivering' } },
      sharedContext,
    );

    return { status: 'requested' };
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
    // First read resolves the beneficiary (and 404s) so we can take the
    // per-beneficiary lock; status is validated UNDER the lock below. The lock
    // must PRECEDE the authoritative status check — otherwise a concurrent
    // reverseCommission could flip status to 'reversed' between our check and
    // our update (TOCTOU), and we'd clobber the reversal with 'suspended'.
    const [pre] = await this.listCommissions(
      { id: input.commissionId },
      { take: 1 },
      sharedContext,
    );
    if (!pre) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Commission '${input.commissionId}' not found.`,
      );
    }
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${pre.beneficiary}`,
    ]);
    // Re-read under the lock — authoritative status for the guard + audit.
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
    // First read resolves the beneficiary (and 404s) so we can take the
    // per-beneficiary lock; status + maturity are validated UNDER the lock below
    // (TOCTOU vs a concurrent reverseCommission — see suspendCommission).
    const [pre] = await this.listCommissions(
      { id: input.commissionId },
      { take: 1 },
      sharedContext,
    );
    if (!pre) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Commission '${input.commissionId}' not found.`,
      );
    }
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${pre.beneficiary}`,
    ]);
    // Re-read under the lock — authoritative status for the guard + audit.
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

  // FX manual-override edit + audit row in the same transaction. The audit row
  // is the only record of who repriced the catalog — never split these writes.
  @InjectTransactionManager()
  async editFxOverride(
    input: {
      manualOverride: boolean;
      manualRate: number | null;
      adminId: string;
      reason: string;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ effective: number }> {
    // Serialize concurrent FX edits so the list-then-create path can't race a
    // duplicate-pair insert (23505) on the very first edit. Same per-key
    // advisory lock as the other singleton writes (setManualFreeze etc.);
    // released automatically at transaction commit.
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      'fx:USD_MYR',
    ]);
    const [row] = await this.listFxRates(
      { pair: 'USD_MYR' },
      { take: 1 },
      sharedContext,
    );
    const before = row
      ? {
          manual_override: row.manual_override,
          manual_rate: row.manual_rate != null ? Number(row.manual_rate) : null,
        }
      : null;

    if (row) {
      await this.updateFxRates(
        [
          {
            id: row.id,
            manual_override: input.manualOverride,
            manual_rate: input.manualRate,
          },
        ],
        sharedContext,
      );
    } else {
      await this.createFxRates(
        [
          {
            pair: 'USD_MYR',
            rate: DEFAULT_USD_MYR,
            source: 'manual',
            manual_override: input.manualOverride,
            manual_rate: input.manualRate,
          },
        ],
        sharedContext,
      );
    }

    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'fx',
          entity_id: 'USD_MYR',
          action: 'edit_fx_rate',
          before,
          after: {
            manual_override: input.manualOverride,
            manual_rate: input.manualRate,
          },
          reason: input.reason,
        },
      ],
      sharedContext,
    );

    const [fresh] = await this.listFxRates(
      { pair: 'USD_MYR' },
      { take: 1 },
      sharedContext,
    );
    return { effective: effectiveRate(fresh ?? null) };
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
          // Sponsor's effective level ranks on their MONOTONIC lifetime external-
          // funded spend (refund-immune; spec §6 — a refund never lowers VIP level
          // or the commission tier it sets), NOT the refund-reducible creditSummary
          // basis (which nets reversed opens to zero). The lifetime counter already
          // backs VIP display/grants; this aligns the commission tier with it.
          // lifetimeExternalSenFor is @InjectManager like creditSummary, so the
          // level read stays off the locked path. (F5)
          const sponsorLifetimeSen =
            await this.lifetimeExternalSenFor(sponsorId);
          // UNIT TRAP: lifetimeExternalSenFor returns integer SEN, but
          // levelForSpend expects MYR (it calls toSen internally) — same
          // conversion the VIP grant path does (rebuildVipMemberState /
          // grantLevelUpRewards). Passing raw SEN would inflate the tier 100×.
          const sponsorLifetimeMyr = fromSen(sponsorLifetimeSen);
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
          const sponsorLevel = levelForSpend(sponsorLifetimeMyr, levelLadder);
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

  // Wallet summary: raw balance, available (freeze-aware), locked (pending-
  // unmatured + suspended commissions), and the earliest pending maturity
  // tranche (date + amount). All amounts in MYR (USD equivalents). Amounts in
  // MYR = amounts as stored (the ledger is already in MYR decimals).
  // available = isFrozen ? 0 : balance − locked  (matches availableBalance).
  @InjectManager()
  async walletSummary(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    balance: number;
    available: number;
    locked: number;
    isFrozen: boolean;
    nextUnlock: { amount: number; date: string } | null;
  }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;

    // Raw balance = Σ(amount) over the append-only ledger, summed in integer
    // cents to avoid float drift (matches availableBalance pattern, spec §8).
    const balRows = await em.execute<{ balance_cents: string | null }[]>(
      'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents ' +
        'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
      [customerId],
    );
    const balance = Number(balRows[0]?.balance_cents ?? 0) / 100;

    // Locked = positive commission credits that are pending-unmatured OR
    // suspended. Reversed/available commissions are excluded (mirroring
    // lockedCommissionCents in availableBalance).
    const lockedCents = await this.lockedCommissionCents(customerId, em);
    const locked = lockedCents / 100;

    // Next unlock = earliest pending maturity in the future + sum of all
    // commission credits maturing at exactly that date for this customer.
    const nextRows = await em.execute<
      { date: string | null; amount_cents: string | null }[]
    >(
      `WITH nxt AS (
         SELECT MIN(c.matures_at) AS d
           FROM credit_transaction ct
           JOIN commission c ON c.credit_transaction_id = ct.id AND c.deleted_at IS NULL
          WHERE ct.customer_id = ? AND c.status = 'pending' AND c.matures_at > now()
            AND ct.deleted_at IS NULL
       )
       SELECT nxt.d AS date,
              COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS amount_cents
         FROM nxt
         LEFT JOIN commission c ON c.matures_at = nxt.d AND c.status = 'pending' AND c.deleted_at IS NULL
         LEFT JOIN credit_transaction ct ON ct.id = c.credit_transaction_id
                   AND ct.customer_id = ? AND ct.deleted_at IS NULL AND ct.amount > 0
        GROUP BY nxt.d`,
      [customerId, customerId],
    );
    const nextRow = nextRows[0];
    const nextUnlock =
      nextRow?.date != null
        ? {
            amount: Number(nextRow.amount_cents ?? 0) / 100,
            date: new Date(nextRow.date).toISOString(),
          }
        : null;

    const frozen = await this.isFrozen(customerId, sharedContext);
    const available = frozen ? 0 : balance - locked;

    return { balance, available, locked, isFrozen: frozen, nextUnlock };
  }

  // Top-N leaderboard computed in the DB (GROUP BY + ORDER BY + LIMIT), so it's
  // correct at any volume.
  //
  // RANKING = real money spent on pack opens, straight from the credit ledger
  // (reason 'pack_open', the same rows the charge step writes). It used to be
  // Σ(current pack price) joined from pulls, which silently rewrote history
  // whenever a pack was repriced or deleted. points = spend(MYR) × 100 (the
  // display convention the storefront always used).
  //
  // volume ("winnings") = Σ won-card VALUE in MYR — market_value(USD) × the
  // card's own multiplier, × the live FX rate — the same displayMarketPrice
  // seam as the vault/open/Top Hits, so the board matches every other surface.
  // Reward-box pulls stay excluded from winnings (source <> 'reward').
  //
  // sinceMs = null → all-time; a timestamp → weekly window.
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
    const fxRate = await resolveFxRate(this);

    // Two windowed aggregates joined by customer: spend from the ledger (the
    // ranking), pulls + winnings from the Pull ledger (display columns). The
    // window predicates are plain `col >= ?` (a nullable-param OR would be
    // non-sargable): the pulls window rides IDX_pull_rolled_at, the spend scan
    // rides the partial IDX_credit_transaction_pack_open_created_at
    // (reason = 'pack_open' rows only).
    const rows = await em.execute<
      {
        customer_id: string;
        pulls: string | null;
        spend_cents: string;
        volume_myr: string | null;
      }[]
    >(
      // NET spend per customer: charges are negative, open-reversals are
      // positive mirror rows with the SAME 'pack_open' reason — summing the
      // net keeps a reversed open from counting as spend. HAVING > 0 drops
      // fully-reversed (or zero-spend) customers from the board. On the
      // WEEKLY window this nets by row date: a reversal landing inside the
      // window subtracts from that week even if its original charge predates
      // it — intended (the week's honest net spend), not a bug.
      'WITH spend AS ( ' +
        '  SELECT customer_id, ROUND(SUM(-amount) * 100)::bigint AS spend_cents ' +
        '    FROM credit_transaction ' +
        "   WHERE reason = 'pack_open' " +
        '     AND deleted_at IS NULL AND customer_id IS NOT NULL ' +
        (since === null ? '' : '     AND created_at >= ?::timestamptz ') +
        '   GROUP BY customer_id ' +
        '   HAVING ROUND(SUM(-amount) * 100) > 0 ' +
        '), wins AS ( ' +
        '  SELECT pu.customer_id, COUNT(*) AS pulls, ' +
        '         SUM(c.market_value * COALESCE(c.market_multiplier, ?)) AS volume_usd ' +
        '    FROM pull pu ' +
        '    LEFT JOIN card c ON c.handle = pu.card_id AND c.deleted_at IS NULL ' +
        "   WHERE pu.deleted_at IS NULL AND pu.customer_id IS NOT NULL AND pu.source <> 'reward' " +
        (since === null ? '' : '     AND pu.rolled_at >= ?::timestamptz ') +
        '   GROUP BY pu.customer_id ' +
        ') ' +
        'SELECT s.customer_id, s.spend_cents, w.pulls, ' +
        '       ROUND(COALESCE(w.volume_usd, 0) * ? * 100) / 100 AS volume_myr ' +
        '  FROM spend s ' +
        '  LEFT JOIN wins w ON w.customer_id = s.customer_id ' +
        ' ORDER BY s.spend_cents DESC, w.pulls DESC NULLS LAST, s.customer_id ASC ' +
        ' LIMIT ?',
      since === null
        ? [DEFAULT_MARKET_MULTIPLIER, fxRate, opts.limit]
        : [since, DEFAULT_MARKET_MULTIPLIER, since, fxRate, opts.limit],
    );

    return rows.map((r) => ({
      customer_id: r.customer_id,
      pulls: Number(r.pulls ?? 0),
      // points = spend × 100 — and spend_cents IS spend × 100 already.
      points: Number(r.spend_cents),
      volume: Number(r.volume_myr ?? 0),
    }));
  }

  // Σ of a customer's pack_open debits, in sen — the same real-spend basis the
  // leaderboard ranks on (points = spend × 100 = exactly these sen). Public
  // profile stats read this so both surfaces always show the same number.
  @InjectManager()
  async packOpenSpendCents(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<number> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    // NET sum: open-reversals are positive 'pack_open' mirror rows, so a
    // reversed open cancels out. Floor at 0 defensively.
    const rows = await em.execute<{ cents: string | null }[]>(
      'SELECT GREATEST(COALESCE(ROUND(SUM(-amount) * 100), 0), 0)::bigint AS cents ' +
        'FROM credit_transaction ' +
        "WHERE customer_id = ? AND reason = 'pack_open' AND deleted_at IS NULL",
      [customerId],
    );
    return Number(rows[0]?.cents ?? 0);
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

  // Privacy-bounded referral summary for ONE customer (spec §7 / Task 5).
  // Returns ONLY the caller's own earnings and their gen-1 (direct) recruits —
  // NEVER an identity below generation 1. The route (Task 6) maps each returned
  // `customerId` to a public handle; resolving the customer module is kept OUT
  // of this service because PacksModuleService deliberately talks to Postgres
  // through raw SQL only (LedgerSqlManager) and does not import other Medusa
  // modules — the leaderboard route owns the no-N+1 handle batch (route.ts).
  //
  // Three reads, all read-only (@InjectManager, so a caller may thread a txn):
  //   1. directRecruits  — gen-1 edges (sponsor_id = me) + per-recruit DIRECT
  //      contribution. The commission ledger row has no source-customer column;
  //      provenance is its source_transaction_id (= the open_id). So the
  //      contribution is a TWO-HOP join: my 'direct_referral' rows -> match
  //      source_transaction_id to the recruit's 'pack_open' row -> that row's
  //      customer_id IS the recruit. Override ('team_override') rows are
  //      excluded by the reason filter, so a gen-2 override never leaks into a
  //      gen-1 recruit's "contribution".
  //   2. downstreamCount — ALL generations under me via a NEW bounded DOWNWARD
  //      recursive CTE (anchor sponsor_id = me, recurse on r.sponsor_id =
  //      down.customer_id), UNION de-dups, an explicit depth cap guarantees
  //      termination. COUNT only — no identities cross the boundary.
  //   3. totalEarned    — Σ my commission ledger rows (direct + override);
  //      negative 'commission_reversal' rows net automatically.
  @InjectManager()
  async referralSummary(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    directRecruits: { customerId: string; contribution: number }[];
    downstreamCount: number;
    totalEarned: number;
  }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;

    // 1) Gen-1 recruits (indexed by sponsor_id).
    const directRows = await em.execute<{ customer_id: string }[]>(
      `SELECT customer_id FROM referral_relationship
         WHERE sponsor_id = ? AND deleted_at IS NULL`,
      [customerId],
    );
    const recruitIds = directRows.map((r) => r.customer_id);

    // Contribution per direct recruit = Σ my DIRECT commission (net of clawbacks)
    // whose source open belongs to that recruit. Two-hop: my 'direct_referral' /
    // 'commission_reversal' rows -> their source_transaction_id -> the recruit's
    // ORIGINAL 'pack_open' debit's customer_id.
    // `IN (?, ?, ...)` not `= ANY(?)`: MikroORM's em.execute expands a JS array
    // into positional binds, so `ANY(?)` would emit `ANY('a','b')` (a syntax
    // error). recruitIds come from our own DB and each id is still bound (not
    // interpolated), so this stays injection-safe.
    //
    // `AND po.amount < 0` is load-bearing: reverseOpen appends a COMPENSATING
    // POSITIVE 'pack_open' refund row carrying the SAME source_transaction_id as
    // the original (negative) debit. Without this guard, one `mine` row would join
    // BOTH pack_open rows and SUM(mine.amount) would double-count that recruit.
    // Filtering `po` to the original debit keeps exactly one join row per open.
    //
    // mine.reason IN ('direct_referral','commission_reversal') NETS the clawback:
    // reverseOpen's commission_reversal row carries the SAME source_transaction_id
    // (= open_id) as the direct_referral it reverses, so the negative reversal
    // cancels the positive credit for that recruit's open — contribution then
    // reflects reversals exactly like totalEarned does. Override reversals point
    // at deeper opens (gen-2+ recruits, never in recruitIds), so the
    // po.customer_id IN (recruitIds) filter naturally excludes them.
    const recruitPlaceholders = recruitIds.map(() => '?').join(', ');
    const contribRows = recruitIds.length
      ? await em.execute<{ recruit_id: string; contribution_cents: string }[]>(
          `SELECT po.customer_id AS recruit_id,
                  COALESCE(SUM(ROUND(mine.amount * 100)), 0)::bigint AS contribution_cents
             FROM credit_transaction mine
             JOIN credit_transaction po
               ON po.source_transaction_id = mine.source_transaction_id
              AND po.reason = 'pack_open'
              AND po.amount < 0
              AND po.deleted_at IS NULL
            WHERE mine.customer_id = ?
              AND mine.reason IN ('direct_referral', 'commission_reversal')
              AND mine.deleted_at IS NULL
              AND po.customer_id IN (${recruitPlaceholders})
            GROUP BY po.customer_id`,
          [customerId, ...recruitIds],
        )
      : [];
    const contribById = new Map<string, number>(
      contribRows.map((r) => [
        r.recruit_id,
        Number(r.contribution_cents) / 100,
      ]),
    );

    // 2) Downstream headcount, ALL generations, via a bounded DOWNWARD walk.
    //    The explicit depth cap + UNION (de-dup) guarantee termination even if a
    //    cycle somehow escaped linkSponsor's guard. Count only — no identities.
    const downRows = await em.execute<{ cnt: number }[]>(
      `WITH RECURSIVE down AS (
         SELECT customer_id, 1 AS depth FROM referral_relationship
           WHERE sponsor_id = ? AND deleted_at IS NULL
         UNION
         SELECT r.customer_id, d.depth + 1
           FROM referral_relationship r
           JOIN down d ON r.sponsor_id = d.customer_id
          WHERE r.deleted_at IS NULL AND d.depth < ?
       )
       SELECT COUNT(*)::int AS cnt FROM down`,
      [customerId, DOWNSTREAM_DEPTH_CAP],
    );
    const downstreamCount = Number(downRows[0]?.cnt ?? 0);

    // 3) Total earned = Σ my commission ledger rows (direct + override); negative
    //    'commission_reversal' rows net automatically.
    const totalRows = await em.execute<{ total_cents: string }[]>(
      `SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS total_cents
         FROM credit_transaction
        WHERE customer_id = ? AND deleted_at IS NULL
          AND reason IN ('direct_referral', 'team_override', 'commission_reversal')`,
      [customerId],
    );
    const totalEarned = Number(totalRows[0]?.total_cents ?? 0) / 100;

    return {
      directRecruits: recruitIds.map((id) => ({
        customerId: id,
        contribution: contribById.get(id) ?? 0,
      })),
      downstreamCount,
      totalEarned,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 4 P4.1 — Admin Observability: referral tree
  // ──────────────────────────────────────────────────────────────────────────

  // Downward recursive CTE: walks DESCENDANTS (children) of customerId, never
  // ancestors. Join direction: r.sponsor_id = t.node_id (DOWN, opposite of the
  // two existing upward CTEs in this file at ~1298 and ~1510).
  @InjectManager()
  async referralTreeFor(
    customerId: string,
    maxDepth: number,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    root: PacksTreeNode;
    nodes: PacksTreeNode[];
    maxDepth: number;
    truncated: boolean;
  }> {
    const depth = Math.max(1, Math.min(10, Math.floor(Number(maxDepth)) || 6));
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;

    // ponytail: LIMIT 1001 → detect >1000 without fetching more rows
    const rows = await em.execute<
      { node_id: string; sponsor_id: string; depth: number }[]
    >(
      `WITH RECURSIVE tree AS (
         SELECT customer_id AS node_id, sponsor_id, 1 AS depth
           FROM referral_relationship
           WHERE sponsor_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT r.customer_id, r.sponsor_id, t.depth + 1
           FROM referral_relationship r
           JOIN tree t ON r.sponsor_id = t.node_id
           WHERE r.deleted_at IS NULL AND t.depth < ?
       )
       SELECT node_id, sponsor_id, depth FROM tree ORDER BY depth, node_id LIMIT 1001`,
      [customerId, depth],
    );
    const truncated = rows.length > 1000;
    const trimmed = truncated ? rows.slice(0, 1000) : rows;

    const allIds = [customerId, ...trimmed.map((r) => r.node_id)];
    const enrich = await this.enrichReferralNodes(allIds, em);

    const root: PacksTreeNode = {
      customer_id: customerId,
      depth: 0,
      sponsor_id: enrich.sponsorOf.get(customerId) ?? null,
      vip_level: enrich.vipLevel.get(customerId) ?? null,
      lifetime_external_spend_sen: enrich.lifetimeSen.get(customerId) ?? '0',
      frozen: enrich.frozen.get(customerId) ?? false,
      direct_recruit_count: enrich.recruitCount.get(customerId) ?? 0,
      has_more_depth: false,
    };
    const nodes: PacksTreeNode[] = trimmed.map((r) => ({
      customer_id: r.node_id,
      depth: r.depth,
      sponsor_id: r.sponsor_id ?? null,
      vip_level: enrich.vipLevel.get(r.node_id) ?? null,
      lifetime_external_spend_sen: enrich.lifetimeSen.get(r.node_id) ?? '0',
      frozen: enrich.frozen.get(r.node_id) ?? false,
      direct_recruit_count: enrich.recruitCount.get(r.node_id) ?? 0,
      has_more_depth:
        r.depth === depth && (enrich.recruitCount.get(r.node_id) ?? 0) > 0,
    }));

    return { root, nodes, maxDepth: depth, truncated };
  }

  @InjectManager()
  async commissionsForBeneficiary(
    customerId: string,
    opts: { limit: number; offset: number },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<CommissionRow[]> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    const offset = Math.max(0, Math.floor(opts.offset) || 0);

    const rows = await em.execute<any[]>(
      `SELECT c.id, c.generation, c.kind, c.status, c.matures_at,
              c.source_transaction_id, c.reversal_transaction_id, c.created_at,
              ct.amount, ct.reason
         FROM commission c
         JOIN credit_transaction ct ON ct.id = c.credit_transaction_id AND ct.deleted_at IS NULL
         WHERE c.beneficiary = ? AND c.deleted_at IS NULL
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT ? OFFSET ?`,
      [customerId, limit, offset],
    );
    if (rows.length === 0) return [];

    // opener provenance: source_transaction_id → the ORIGINAL pack_open debit (amount<0)
    // ponytail: amount<0 guard — reverseOpen appends a compensating POSITIVE pack_open row
    // sharing the same source_transaction_id; without this filter the join double-counts.
    const openIds = [...new Set(rows.map((r) => r.source_transaction_id))];
    const ph = openIds.map(() => '?').join(',');
    const opens = await em.execute<
      { source_transaction_id: string; customer_id: string }[]
    >(
      `SELECT source_transaction_id, customer_id FROM credit_transaction
         WHERE source_transaction_id IN (${ph})
           AND reason = 'pack_open' AND amount < 0 AND deleted_at IS NULL`,
      openIds,
    );
    const openerOf = new Map(
      opens.map((o) => [o.source_transaction_id, o.customer_id]),
    );

    return rows.map((r) => ({
      id: r.id,
      generation: Number(r.generation),
      kind: r.kind,
      status: r.status,
      amount: String(r.amount),
      reason: r.reason,
      matures_at: r.matures_at,
      reversal_transaction_id: r.reversal_transaction_id ?? null,
      source_transaction_id: r.source_transaction_id,
      opener_customer_id: openerOf.get(r.source_transaction_id) ?? null,
      created_at: r.created_at,
    }));
  }

  /** Phase 4 P4.2 — 3-way audit union for a customer.
   *
   *  Covers all three entity_type keys used by admin_action_audit:
   *    (a) entity_type='customer'   keyed by customerId          (freeze/unfreeze)
   *    (b) entity_type='commission' keyed by commission.id       (reverse/suspend/unsuspend)
   *    (c) entity_type='credit'     keyed by credit_transaction.id (adjust_credit)
   *
   *  A single entity_id=customerId filter silently drops (b) and (c).
   *  "before"/"after" are double-quoted — reserved words in SQL.
   */
  @InjectManager()
  async auditForCustomer(
    customerId: string,
    opts: { limit: number; offset: number },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ account_state: any | null; actions: AuditRow[] }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit) || 50));
    const offset = Math.max(0, Math.floor(opts.offset) || 0);

    const actions = await em.execute<AuditRow[]>(
      `SELECT id, entity_type, entity_id, action, "before", "after", reason, created_at, admin_id
         FROM admin_action_audit
         WHERE deleted_at IS NULL AND (
           (entity_type = 'customer' AND entity_id = ?)
           OR (entity_type = 'commission' AND entity_id IN
                (SELECT id FROM commission WHERE beneficiary = ? AND deleted_at IS NULL))
           OR (entity_type = 'credit' AND entity_id IN
                (SELECT id FROM credit_transaction WHERE customer_id = ? AND reason = 'adjustment' AND deleted_at IS NULL))
         )
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      [customerId, customerId, customerId, limit, offset],
    );
    const [state] = await this.listCustomerAccountStates(
      { customer_id: customerId },
      { take: 1 },
      sharedContext,
    );
    return { account_state: state ?? null, actions };
  }

  // Batched enrichment for referral tree nodes — packs-owned tables only
  // (no cross-module calls at the service level; customer identity resolved at route).
  private async enrichReferralNodes(ids: string[], em: LedgerSqlManager) {
    const sponsorOf = new Map<string, string>();
    const vipLevel = new Map<string, number>();
    const lifetimeSen = new Map<string, string>();
    const frozen = new Map<string, boolean>();
    const recruitCount = new Map<string, number>();
    if (ids.length === 0)
      return { sponsorOf, vipLevel, lifetimeSen, frozen, recruitCount };

    const ph = ids.map(() => '?').join(',');
    // Sequential to avoid concurrent queries on the shared injected EntityManager.
    const rels = await em.execute<
      { customer_id: string; sponsor_id: string }[]
    >(
      `SELECT customer_id, sponsor_id FROM referral_relationship WHERE customer_id IN (${ph}) AND deleted_at IS NULL`,
      ids,
    );
    const vms = await em.execute<
      {
        customer_id: string;
        current_level: number;
        lifetime_external_spend_sen: string;
      }[]
    >(
      `SELECT customer_id, current_level, lifetime_external_spend_sen FROM vip_member_state WHERE customer_id IN (${ph}) AND deleted_at IS NULL`,
      ids,
    );
    const cas = await em.execute<{ customer_id: string; frozen: boolean }[]>(
      `SELECT customer_id, frozen FROM customer_account_state WHERE customer_id IN (${ph}) AND deleted_at IS NULL`,
      ids,
    );
    const counts = await em.execute<{ sponsor_id: string; n: string }[]>(
      `SELECT sponsor_id, COUNT(*) AS n FROM referral_relationship WHERE sponsor_id IN (${ph}) AND deleted_at IS NULL GROUP BY sponsor_id`,
      ids,
    );
    for (const r of rels) sponsorOf.set(r.customer_id, r.sponsor_id);
    for (const r of vms) {
      vipLevel.set(r.customer_id, Number(r.current_level));
      lifetimeSen.set(r.customer_id, String(r.lifetime_external_spend_sen));
    }
    for (const r of cas) frozen.set(r.customer_id, Boolean(r.frozen));
    for (const r of counts) recruitCount.set(r.sponsor_id, Number(r.n));
    return { sponsorOf, vipLevel, lifetimeSen, frozen, recruitCount };
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

  // Atomic, guarded pull-status transition — THE seam every vaulted→X flip must
  // use (buyback, delivery request, deliver/cancel). One conditional UPDATE
  // (`WHERE status = from`) inside a transaction: if ANY requested pull is not
  // currently in `from`, the whole batch throws and rolls back — closing the
  // read-then-unconditional-write race that let one pull be sold back AND
  // shipped (2026-07-07 audit #1). `set` carries the buyback snapshot columns
  // so the flip and its money stamp are one atomic statement.
  @InjectTransactionManager()
  async transitionPullStatus(
    input: {
      ids: string[];
      from: 'vaulted' | 'delivering';
      to: 'vaulted' | 'bought_back' | 'delivering' | 'delivered';
      set?: { buyback_amount?: number; buyback_at?: Date };
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    if (input.ids.length === 0) return;
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const setCols = ['status = ?', 'updated_at = NOW()'];
    const params: unknown[] = [input.to];
    if (input.set?.buyback_amount !== undefined) {
      setCols.splice(1, 0, 'buyback_amount = ?');
      params.push(input.set.buyback_amount);
    }
    if (input.set?.buyback_at !== undefined) {
      setCols.splice(setCols.length - 1, 0, 'buyback_at = ?');
      params.push(input.set.buyback_at);
    }
    const placeholders = input.ids.map(() => '?').join(', ');
    const rows = await em.execute<{ id: string }[]>(
      `UPDATE pull SET ${setCols.join(', ')} ` +
        `WHERE id IN (${placeholders}) AND status = ? AND deleted_at IS NULL ` +
        'RETURNING id',
      [...params, ...input.ids, input.from],
    );
    if (rows.length !== input.ids.length) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'One or more cards changed state — refresh and try again.',
      );
    }
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
      withdrawals_per_day: row ? Number(row.withdrawals_per_day) : 1,
    };
    const data = {
      commission_cooldown_days:
        patch.commissionCooldownDays ?? before.commissionCooldownDays,
      team_override_pct: patch.teamOverridePct ?? before.teamOverridePct,
      override_generation_cap:
        patch.overrideGenerationCap ?? before.overrideGenerationCap,
      withdrawals_per_day:
        patch.withdrawals_per_day ?? before.withdrawals_per_day,
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
      withdrawals_per_day: data.withdrawals_per_day,
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

  // Outstanding voucher liability: sum of amount_myr across all GRANTED,
  // unfulfilled voucher reward grants. These are off-ledger obligations — each
  // represents a future redemption the operator owes. Uses @InjectManager so
  // callers outside a transaction get a fresh connection.
  @InjectManager()
  async outstandingVoucherLiabilityMyr(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<number> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const rows = await em.execute<{ liability: string | null }[]>(
      `SELECT COALESCE(SUM((payload->>'amount_myr')::numeric), 0) AS liability
         FROM vip_reward_grant
        WHERE kind='voucher' AND status='granted' AND deleted_at IS NULL`,
    );
    return Number(rows[0]?.liability ?? 0);
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

  // Shared VIP-state inputs read from the authoritative ledger: the monotonic
  // lifetime counter (SEN), the net-basis external spend (MYR, the display axis),
  // and the full ladder (threshold + reward columns). Both rebuildVipMemberState
  // and grantLevelUpRewards need exactly these, so they live in one place and can
  // never drift in what they read. Reads stay SEQUENTIAL: lifetimeExternalSenFor
  // and listVipLevels run on the same injected EntityManager, which is not safe to
  // query concurrently — so this is a DRY extraction, not a parallelization.
  private async loadVipStateInputs(
    customerId: string,
    sharedContext: Context = {},
  ) {
    const lifetimeSen = await this.lifetimeExternalSenFor(
      customerId,
      sharedContext,
    );
    const netBasisMyr = (await this.creditSummary(customerId))
      .externalFundedSpendTotal;
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
    return { lifetimeSen, netBasisMyr, ladderRows, thresholdRows };
  }

  // Rebuild the vip_member_state projection for a single customer from the
  // authoritative ledger. Safe to call repeatedly — the upsert is idempotent.
  // lifetime uses the monotonic counter (fromSen for levelForSpend unit conversion);
  // current_level uses the net-basis summary (may drop on refund).
  async rebuildVipMemberState(
    customerId: string,
    sharedContext: Context = {},
  ): Promise<void> {
    const { lifetimeSen, netBasisMyr, thresholdRows } =
      await this.loadVipStateInputs(customerId, sharedContext);
    await this.upsertVipMemberState(
      {
        customerId,
        lifetimeSen,
        highestLevelEver: levelForSpend(fromSen(lifetimeSen), thresholdRows), // fromSen: SEN→MYR unit conversion (UNIT TRAP)
        currentLevel: levelForSpend(netBasisMyr, thresholdRows),
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
  // WHERE deleted_at IS NULL AND origin = 'ladder' DO NOTHING so a replayed event
  // with the same (customerId, openId) simply skips existing rows without raising
  // a 23505. A try/catch around the ORM's createVipRewardGrants would poison the
  // enclosing txn (Postgres 25P02) on the first duplicate — raw DO NOTHING avoids
  // this entirely. The partial WHERE clause must match the
  // UQ_vip_reward_grant_customer_level_kind partial index (defined in
  // vip-reward-grant.ts with `where: "deleted_at IS NULL AND origin = 'ladder'"`).
  // origin discriminates ladder grants (this method) from box-won grants, which
  // are repeatable per (customer, level, kind) and fall outside this index.
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

    // 1-3) Recompute the shared VIP-state inputs from the ledger (monotonic
    //       lifetime, net basis, full ladder) — the same source
    //       rebuildVipMemberState uses, so redelivery stays idempotent and the
    //       two paths cannot drift in what they read.
    const { lifetimeSen, netBasisMyr, ladderRows, thresholdRows } =
      await this.loadVipStateInputs(customerId, sharedContext);
    // UNIT TRAP: lifetimeSen is integer sen, levelForSpend expects MYR. Convert.
    const lifetimeMyr = fromSen(lifetimeSen);
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
        // UQ_vip_reward_grant_customer_level_kind (where: "deleted_at IS NULL AND
        // origin = 'ladder'"). origin is always 'ladder' here — box-won grants are
        // inserted elsewhere with origin: 'box' and are not subject to this arbiter.
        // Deterministic id: vrg_<customerId>_<level>_<kind> for deduplication.
        const grantId = `vrg_${customerId}_${L}_${reward.kind}`;
        await em.execute(
          `INSERT INTO vip_reward_grant
             (id, customer_id, level, kind, payload, status, source_open_id, origin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?::jsonb, 'granted', ?, 'ladder', now(), now())
           ON CONFLICT (customer_id, level, kind) WHERE deleted_at IS NULL AND origin = 'ladder' DO NOTHING`,
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
    //    COLLATE "C" forces byte-order (C locale) sort on the outer ORDER BY,
    //    matching JS plain Array.sort() (UTF-16 lexicographic). Without it, Postgres
    //    uses the DB's default collation (e.g. en_US.utf8), which reorders mixed-case
    //    IDs differently — creating an AB-BA deadlock vector when this job and a
    //    concurrent reverseOpen/reverseCommission acquire credit: locks on the same
    //    beneficiaries in conflicting orders.
    //    The subquery pattern is required because Postgres rejects COLLATE in ORDER BY
    //    when SELECT DISTINCT is used (the ORDER BY expression must appear literally
    //    in the SELECT list; COLLATE makes it a distinct expression).
    const due = await em.execute<{ beneficiary: string }[]>(
      `SELECT beneficiary FROM (
          SELECT DISTINCT beneficiary FROM commission
           WHERE status = 'pending' AND matures_at <= now() AND deleted_at IS NULL
         ) _b
        ORDER BY beneficiary COLLATE "C"`,
    );

    let flipped = 0;

    for (const { beneficiary } of due) {
      // 2) Acquire per-beneficiary advisory lock (same credit: keyspace used by
      //    mutateCreditAtomic, settleOpen, reverseCommission, reverseOpen).
      //    Transaction-scoped — auto-releases on commit/rollback.
      await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `credit:${beneficiary}`,
      ]);

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

  // ---- Daily Rewards (Task 5) ----------------------------------------------
  // getDailyState / drawDailyBox are the model-driven (reward_box +
  // reward_box_prize) daily-box path — the sole reward-box draw path since
  // Task 7 deleted the old PackOdds-based settleRewardDraw.
  // Kept THIN: all pure pick/validate/fold logic lives in daily-box.ts /
  // voucher-ranges.ts; this file only orchestrates DB reads/writes.

  // Batch-resolve product title + thumbnail by handle (product-lookup helper
  // for the 'product' prize branch — Modules.PRODUCT.listProducts).
  private async resolveProductDisplay(
    handles: string[],
    container: MedusaContainer,
  ): Promise<Map<string, { title: string; image: string }>> {
    const out = new Map<string, { title: string; image: string }>();
    if (handles.length === 0) return out;
    const productModule = container.resolve(Modules.PRODUCT);
    const products = await productModule.listProducts(
      { handle: handles },
      { select: ['handle', 'title', 'thumbnail'] },
    );
    for (const p of products as {
      handle?: string;
      title: string;
      thumbnail?: string;
    }[]) {
      if (!p.handle) continue;
      out.set(p.handle, { title: p.title, image: p.thumbnail ?? '' });
    }
    return out;
  }

  // Two-hop tier resolution shared by getDailyState/drawDailyBox: default to
  // the floor level (L1) when the customer has no state row yet (mirrors
  // grantLevelUpRewards / settleRewardDraw).
  private async resolveBoxTier(
    customerId: string,
    sharedContext: Context,
  ): Promise<string> {
    const [state] = await this.listVipMemberStates(
      { customer_id: customerId },
      { take: 1 },
      sharedContext,
    );
    const level = state ? Number(state.highest_level_ever) : 1;
    const [vipLevel] = await this.listVipLevels(
      { level },
      { take: 1 },
      sharedContext,
    );
    return vipLevel?.box_tier ?? '';
  }

  // highest_level_ever, defaulting to the L1 floor — the level a box-won
  // voucher grant is stamped with (mirrors resolveBoxTier's own read).
  private async resolveMemberLevel(
    customerId: string,
    sharedContext: Context,
  ): Promise<number> {
    const [state] = await this.listVipMemberStates(
      { customer_id: customerId },
      { take: 1 },
      sharedContext,
    );
    return state ? Number(state.highest_level_ever) : 1;
  }

  // The logged-in customer's daily-box + voucher-grant state in one read (B6
  // successor). NEVER returns weight/locked/odds fields — those stay
  // server-side. `prizes` showcases only UNLOCKED prize rows so the UI can't
  // infer a locked pin's pct from its absence/presence pattern.
  @InjectManager()
  async getDailyState(
    customerId: string,
    container?: MedusaContainer,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<DailyState> {
    const resolveContainer =
      container ??
      (this as unknown as { __container__: MedusaContainer }).__container__;
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;

    const tier = await this.resolveBoxTier(customerId, sharedContext);

    let box: DailyState['box'] = null;
    if (tier) {
      const [rewardBox] = await this.listRewardBoxes(
        { tier },
        { take: 1 },
        sharedContext,
      );
      if (rewardBox && rewardBox.enabled) {
        const drawDay = new Date().toISOString().slice(0, 10);
        const countRows = await em.execute<{ n: string | null }[]>(
          `SELECT COUNT(*) AS n FROM reward_draw
             WHERE customer_id = ? AND draw_day = ? AND deleted_at IS NULL`,
          [customerId, drawDay],
        );
        const drawsToday = Number(countRows[0]?.n ?? 0);

        const prizeRows = await this.listRewardBoxPrizes(
          { box_id: rewardBox.id, locked: false },
          { take: 1000 },
          sharedContext,
        );
        const productHandles = prizeRows
          .filter((p) => p.kind === 'product')
          .map((p) => (p.payload as { product_handle?: string }).product_handle)
          .filter((h): h is string => Boolean(h));
        const displayByHandle = await this.resolveProductDisplay(
          productHandles,
          resolveContainer,
        );
        const prizes = prizeRows.map((p) => {
          const payload = p.payload as {
            amount_myr?: number;
            product_handle?: string;
          };
          if (p.kind === 'product') {
            const display = payload.product_handle
              ? displayByHandle.get(payload.product_handle)
              : undefined;
            return {
              kind: 'product',
              title: display?.title,
              image: display?.image,
            };
          }
          if (p.kind === 'credit' || p.kind === 'voucher') {
            return {
              kind: p.kind,
              amount_myr: Number(payload.amount_myr ?? 0),
            };
          }
          return { kind: 'nothing' };
        });

        // Next UTC midnight — the reset boundary for tomorrow's draw_day.
        const nextReset = new Date(`${drawDay}T00:00:00.000Z`);
        nextReset.setUTCDate(nextReset.getUTCDate() + 1);

        box = {
          tier,
          name: rewardBox.name,
          draws_per_day: rewardBox.draws_per_day,
          draws_today: drawsToday,
          next_reset: nextReset.toISOString(),
          prizes,
        };
      }
    }

    const grantRows = await this.listVipRewardGrants(
      { customer_id: customerId, kind: ['voucher', 'frame'] },
      { order: { created_at: 'DESC' }, take: 500 },
      sharedContext,
    );
    const toGrantView = (g: (typeof grantRows)[number]): GrantView => ({
      id: g.id,
      kind: g.kind as 'voucher' | 'frame',
      level: g.level,
      payload: g.payload,
      granted_at: g.created_at.toISOString(),
      origin: (g.origin as 'ladder' | 'box' | null) ?? 'ladder',
    });
    const vouchers = {
      claimable: grantRows
        .filter((g) => g.status === 'granted')
        .map(toGrantView),
      claimed: grantRows
        .filter((g) => g.status === 'fulfilled')
        .map(toGrantView),
    };

    // ship_prizes — ported from GET /store/rewards (ships/vaulted reward Pulls).
    const rewardPulls = await this.listPulls(
      { customer_id: customerId, status: 'vaulted', source: 'reward' },
      { order: { rolled_at: 'DESC' }, take: 500 },
      sharedContext,
    );
    const pullIds = rewardPulls.map((p) => p.id);
    const drawRows = pullIds.length
      ? await this.listRewardDraws(
          { vault_pull_id: pullIds },
          { take: pullIds.length },
          sharedContext,
        )
      : [];
    const drawByPullId = new Map(drawRows.map((d) => [d.vault_pull_id, d]));
    const shipPrizes: PrizeView[] = rewardPulls
      .map((p): PrizeView | null => {
        const d = drawByPullId.get(p.id);
        if (!d) return null;
        return {
          pull_id: p.id,
          prize_kind: d.prize_kind as string,
          prize_snapshot: d.prize_snapshot,
          status: p.status as string,
          draw_day: d.draw_day as string,
        };
      })
      .filter((e): e is PrizeView => e !== null);

    return {
      redemption_enabled: rewardsRedemptionEnabled(),
      box,
      vouchers,
      ship_prizes: shipPrizes,
    };
  }

  // Settle one daily reward-box draw for a customer, against the NEW
  // reward_box/reward_box_prize model. Same read-then-write-under-lock
  // discipline as settleRewardDraw (advisory lock, UTC draw_day, cap COUNT,
  // reward_draw INSERT) — copied verbatim from that method (L1386-1394,
  // L1436-1447 in the pre-Task-5 file). The prize pick runs over ALL prize
  // rows (locked AND unlocked) via the stored weights — locked only pins the
  // roll's probability, it never excludes a row from the pool.
  @InjectTransactionManager()
  async drawDailyBox(
    customerId: string,
    container?: MedusaContainer,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<DrawDailyBoxResult> {
    if (!rewardsRedemptionEnabled()) {
      return { status: 'unavailable' };
    }

    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const resolveContainer =
      container ??
      (this as unknown as { __container__: MedusaContainer }).__container__;

    // 0) Serialize all credit mutations for THIS customer — ported verbatim
    //    from settleRewardDraw.
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);
    await this.assertNotFrozen(customerId, sharedContext);

    // 1) Two-hop tier resolution (same helper getDailyState uses).
    const tier = await this.resolveBoxTier(customerId, sharedContext);
    if (!tier) return { status: 'unavailable' };

    const [rewardBox] = await this.listRewardBoxes(
      { tier },
      { take: 1 },
      sharedContext,
    );
    if (!rewardBox || !rewardBox.enabled) {
      return { status: 'unavailable' };
    }

    const prizeRows = await this.listRewardBoxPrizes(
      { box_id: rewardBox.id },
      { take: 1000 },
      sharedContext,
    );
    if (prizeRows.length === 0) {
      return { status: 'unavailable' };
    }

    // 2) Daily-cap COUNT under the lock — ported verbatim from settleRewardDraw.
    const drawDay = new Date().toISOString().slice(0, 10);
    const countRows = await em.execute<{ n: string | null }[]>(
      `SELECT COUNT(*) AS n FROM reward_draw
         WHERE customer_id = ? AND draw_day = ? AND deleted_at IS NULL`,
      [customerId, drawDay],
    );
    const count = Number(countRows[0]?.n ?? 0);
    if (count >= rewardBox.draws_per_day) {
      return { status: 'capped' };
    }

    // 3) Roll over the box's stored weights (locked rows included).
    const roll = randomInt(10000);
    const won = pickPrize(
      prizeRows.map((p) => ({ ...p, weight: p.weight })),
      roll,
    );
    const payload = won.payload as {
      amount_myr?: number;
      product_handle?: string;
      qty?: number;
    };

    const drawOrdinal = count + 1;
    let vaultPullId: string | null = null;
    let creditTxnId: string | null = null;
    let resultPrize: DrawDailyBoxResult['prize'];
    let prizeSnapshot: Record<string, unknown>;
    // Recorded prize_kind — starts as the roll's kind, degrades to 'nothing'
    // below if the product stock/existence gate fails (Finding 1).
    let prizeKind: 'product' | 'credit' | 'voucher' | 'nothing' = won.kind;

    if (won.kind === 'product') {
      const handle = payload.product_handle ?? '';
      const qty = Number(payload.qty ?? 1);
      const display = handle
        ? (await this.resolveProductDisplay([handle], resolveContainer)).get(
            handle,
          )
        : undefined;

      // Post-roll gate (§Finding 1) — degrading (not re-rolling / not
      // pre-filtering) keeps admin-pinned locked odds honest: the authored
      // odds table stays what was configured, and odds_snapshot below still
      // records it truthfully. A dead/missing product or insufficient stock
      // (< qty, Finding 2) turns this draw into 'nothing' instead of minting
      // a Pull the shipping pipeline can't back.
      const stockByHandle = handle
        ? await getCardStockByHandle(resolveContainer, [handle])
        : new Map<string, number | null>();
      const stock = stockByHandle.get(handle);
      const inStock =
        Boolean(display) &&
        stockByHandle.has(handle) &&
        (stock === null || (stock !== undefined && stock >= qty));

      if (!inStock) {
        resultPrize = { kind: 'nothing' };
        prizeSnapshot = { degraded_from: 'product', product_handle: handle };
        prizeKind = 'nothing';
      } else {
        for (let i = 0; i < qty; i += 1) {
          const [pull] = await this.createPulls(
            [
              {
                customer_id: customerId,
                pack_id: `reward-box-${tier}`,
                card_id: handle,
                order_id: null,
                rolled_at: new Date(),
                source: 'reward',
              },
            ],
            sharedContext,
          );
          vaultPullId = pull.id;
        }
        resultPrize = {
          kind: 'product',
          title: display?.title,
          image: display?.image,
          product_handle: handle,
        };
        prizeSnapshot = {
          product_handle: handle,
          title: display?.title ?? '',
          image: display?.image ?? '',
          qty,
        };
      }
    } else if (won.kind === 'credit') {
      const amountMyr = Number(payload.amount_myr ?? 0);
      // Defense-in-depth ceiling, mirroring settleRewardDraw's MAX_REWARD_CREDIT_MYR
      // guard — the authoring validator and the stored-weight table both already
      // cap this, but fail loud here too.
      if (amountMyr > MAX_BOX_CREDIT_MYR) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Reward credit ${amountMyr} exceeds the ${MAX_BOX_CREDIT_MYR} MYR cap.`,
        );
      }
      const { id } = await this.mutateCreditAtomic(
        {
          customerId,
          amount: amountMyr,
          reason: 'reward_credit',
          idempotencyReference: `reward:${customerId}:${drawDay}:${drawOrdinal}`,
        },
        sharedContext,
      );
      creditTxnId = id;
      resultPrize = { kind: 'credit', amount_myr: amountMyr };
      prizeSnapshot = { amount_myr: amountMyr, currency: 'MYR' };
    } else if (won.kind === 'voucher') {
      const amountMyr = Number(payload.amount_myr ?? 0);
      resultPrize = { kind: 'voucher', amount_myr: amountMyr };
      prizeSnapshot = { amount_myr: amountMyr, currency: 'MYR' };
    } else {
      resultPrize = { kind: 'nothing' };
      prizeSnapshot = {};
    }

    const [draw] = await this.createRewardDraws(
      [
        {
          customer_id: customerId,
          tier,
          draw_day: drawDay,
          draw_ordinal: drawOrdinal,
          // prizeKind (not won.kind) — a degraded product prize records
          // 'nothing' here so the audit trail matches what actually happened
          // (no Pull, no credit), even though the roll picked 'product'.
          prize_kind: prizeKind,
          prize_snapshot: prizeSnapshot,
          odds_snapshot: {
            tier,
            computed: prizeRows.map((p) => ({
              kind: p.kind,
              weight: p.weight,
              locked: p.locked,
            })),
          },
          vault_pull_id: vaultPullId,
          credit_txn_id: creditTxnId,
          status: 'drawn',
        },
      ],
      sharedContext,
    );

    // Voucher payout happens AFTER the draw row exists so source_open_id can
    // point at it directly — origin:'box' puts this grant outside the ladder's
    // partial-unique index, so it's fine for a customer to win the same
    // (level, kind) more than once from a box.
    if (won.kind === 'voucher') {
      const amountMyr = Number(payload.amount_myr ?? 0);
      const level = await this.resolveMemberLevel(customerId, sharedContext);
      await this.createVipRewardGrants(
        [
          {
            customer_id: customerId,
            level,
            kind: 'voucher',
            payload: { amount_myr: amountMyr },
            status: 'granted',
            origin: 'box',
            source_open_id: draw.id,
          },
        ],
        sharedContext,
      );
    }

    return {
      status: 'drawn',
      prize: resultPrize,
      draw_ordinal: drawOrdinal,
    };
  }

  // Admin listing: every reward_box row + prize/customer counts (read-only).
  // Customer counts + level ranges come from ONE grouped SQL over
  // vip_member_state JOIN vip_level (highest_level_ever = level), grouped by
  // box_tier — cheaper than N+1 per-tier lookups.
  @InjectManager()
  async listDailyBoxesWithMeta(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<
    {
      tier: string;
      name: string;
      enabled: boolean;
      draws_per_day: number;
      prize_count: number;
      customer_count: number;
      level_from: number | null;
      level_to: number | null;
    }[]
  > {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;

    const boxes = await this.listRewardBoxes({}, { take: 1000 }, sharedContext);
    const prizeRows = await this.listRewardBoxPrizes(
      {},
      { take: 100000, select: ['box_id'] },
      sharedContext,
    );
    const prizeCountByBox = new Map<string, number>();
    for (const p of prizeRows) {
      prizeCountByBox.set(p.box_id, (prizeCountByBox.get(p.box_id) ?? 0) + 1);
    }

    const metaRows = await em.execute<
      {
        box_tier: string;
        customer_count: string;
        level_from: number;
        level_to: number;
      }[]
    >(
      `SELECT vl.box_tier AS box_tier,
              COUNT(DISTINCT vms.customer_id) AS customer_count,
              MIN(vl.level) AS level_from,
              MAX(vl.level) AS level_to
         FROM vip_level vl
         LEFT JOIN vip_member_state vms
           ON vms.highest_level_ever = vl.level AND vms.deleted_at IS NULL
        WHERE vl.deleted_at IS NULL
        GROUP BY vl.box_tier`,
    );
    const metaByTier = new Map(metaRows.map((r) => [r.box_tier, r]));

    return boxes.map((b) => {
      const meta = metaByTier.get(b.tier);
      return {
        tier: b.tier,
        name: b.name,
        enabled: b.enabled,
        draws_per_day: b.draws_per_day,
        prize_count: prizeCountByBox.get(b.id) ?? 0,
        customer_count: meta ? Number(meta.customer_count) : 0,
        level_from: meta ? Number(meta.level_from) : null,
        level_to: meta ? Number(meta.level_to) : null,
      };
    });
  }

  // Admin editor read for one tier: box config + every prize row (incl.
  // locked/pct — authoring-only; never reused for a store-facing response).
  @InjectManager()
  async getDailyBoxEditor(
    tier: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    box: {
      tier: string;
      name: string;
      enabled: boolean;
      draws_per_day: number;
    };
    prizes: {
      id: string;
      kind: string;
      payload: unknown;
      locked: boolean;
      pct: number;
    }[];
  }> {
    const [rewardBox] = await this.listRewardBoxes(
      { tier },
      { take: 1 },
      sharedContext,
    );
    if (!rewardBox) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `No reward box configured for tier '${tier}'.`,
      );
    }
    const prizeRows = await this.listRewardBoxPrizes(
      { box_id: rewardBox.id },
      { take: 1000 },
      sharedContext,
    );
    return {
      box: {
        tier: rewardBox.tier,
        name: rewardBox.name,
        enabled: rewardBox.enabled,
        draws_per_day: rewardBox.draws_per_day,
      },
      prizes: prizeRows.map((p) => ({
        id: p.id,
        kind: p.kind,
        payload: p.payload,
        locked: p.locked,
        pct: p.weight / 100,
      })),
    };
  }

  // Atomic replace-all of one tier's box config + prize table (mirrors
  // replaceRewardPool's delete-all/create-all + audit pattern). Called by
  // saveDailyBoxWorkflow AFTER it has already validated the body and computed
  // weights (pure logic stays outside the transaction).
  @InjectTransactionManager()
  async saveDailyBox(
    input: {
      tier: string;
      body: DailyBoxBody;
      weights: { weight: number; locked: boolean }[];
      adminId: string;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    tier: string;
    prize_count: number;
    enabled: boolean;
    draws_per_day: number;
  }> {
    const [rewardBox] = await this.listRewardBoxes(
      { tier: input.tier },
      { take: 1 },
      sharedContext,
    );
    if (!rewardBox) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `No reward box configured for tier '${input.tier}'.`,
      );
    }

    const priorPrizes = await this.listRewardBoxPrizes(
      { box_id: rewardBox.id },
      { take: 1000 },
      sharedContext,
    );
    const priorPrizeIds = priorPrizes.map((p) => p.id);
    if (priorPrizeIds.length > 0) {
      await this.deleteRewardBoxPrizes(priorPrizeIds, sharedContext);
    }
    if (input.body.prizes.length > 0) {
      await this.createRewardBoxPrizes(
        input.body.prizes.map((p: BoxPrizeInput, i: number) => ({
          box_id: rewardBox!.id,
          kind: p.kind,
          weight: input.weights[i].weight,
          locked: input.weights[i].locked,
          payload:
            p.kind === 'product'
              ? { product_handle: p.product_handle, qty: p.qty }
              : p.kind === 'credit' || p.kind === 'voucher'
                ? { amount_myr: p.amount_myr }
                : {},
        })),
        sharedContext,
      );
    }

    const before = {
      name: rewardBox.name,
      enabled: rewardBox.enabled,
      draws_per_day: rewardBox.draws_per_day,
      prize_count: priorPrizeIds.length,
    };
    await this.updateRewardBoxes(
      {
        selector: { id: rewardBox.id },
        data: {
          name: input.body.name,
          enabled: input.body.enabled,
          draws_per_day: input.body.draws_per_day,
        },
      },
      sharedContext,
    );

    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'daily_box',
          entity_id: rewardBox.id,
          action: 'edit_daily_box',
          before,
          after: {
            name: input.body.name,
            enabled: input.body.enabled,
            draws_per_day: input.body.draws_per_day,
            prize_count: input.body.prizes.length,
          },
          reason: input.body.reason,
        },
      ],
      sharedContext,
    );

    return {
      tier: input.tier,
      prize_count: input.body.prizes.length,
      enabled: input.body.enabled,
      draws_per_day: input.body.draws_per_day,
    };
  }

  // All 100 vip_level rows, ascending — the voucher ladder editor's read side.
  @InjectManager()
  async getVoucherLadder(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ level: number; amount_myr: number }[]> {
    const rows = await this.listVipLevels(
      {},
      { select: ['level', 'voucher_amount'], take: 1000 },
      sharedContext,
    );
    return rows
      .map((r) => ({ level: r.level, amount_myr: Number(r.voucher_amount) }))
      .sort((a, b) => a.level - b.level);
  }

  // Fold admin ranges → the 100-entry ladder, update only the CHANGED
  // vip_level rows (no-op writes for untouched levels), and write ONE audit
  // row — same pattern as editDailyRewardSettings/replaceRewardPool.
  @InjectTransactionManager()
  async saveVoucherRanges(
    ranges: VoucherRange[],
    adminId: string,
    reason: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const amounts = foldRanges(ranges);

    const rows = await this.listVipLevels(
      {},
      { select: ['id', 'level', 'voucher_amount'], take: 1000 },
      sharedContext,
    );
    const byLevel = new Map(rows.map((r) => [r.level, r]));

    const before: Record<number, number> = {};
    const after: Record<number, number> = {};
    for (let i = 0; i < amounts.length; i++) {
      const level = i + 1;
      const row = byLevel.get(level);
      if (!row) continue;
      const priorAmount = Number(row.voucher_amount);
      const nextAmount = amounts[i];
      if (priorAmount === nextAmount) continue;
      before[level] = priorAmount;
      after[level] = nextAmount;
      await this.updateVipLevels(
        { selector: { id: row.id }, data: { voucher_amount: nextAmount } },
        sharedContext,
      );
    }

    await this.createAdminActionAudits(
      [
        {
          admin_id: adminId,
          entity_type: 'voucher_ladder',
          entity_id: 'singleton',
          action: 'edit_voucher_ladder',
          before,
          after,
          reason,
        },
      ],
      sharedContext,
    );
  }
}

export default PacksModuleService;
