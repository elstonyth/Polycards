import { randomInt, randomUUID } from 'node:crypto';
import {
  MedusaService,
  MedusaError,
  InjectManager,
  InjectTransactionManager,
  MedusaContext,
  Modules,
} from '@medusajs/framework/utils';
import type { Context, HttpTypes } from '@medusajs/framework/types';
import { PCT_SCALE } from '@acme/odds-math';
import type { OddsRarity, TierRangeMap } from '@acme/odds-math';
import {
  validateDeliveryRequest,
  validateDeliveryStatusTransition,
  snapshotAddress,
  type AddressSnapshot,
  type DeliveryStatus,
} from './delivery';
import { rewardsRedemptionEnabled } from './rewards-gate';
import { playthroughState, withdrawalGateError } from './withdrawable';
import {
  loadSavedBankAccounts,
  resolveWithdrawalDestination,
  type SavedBankAccount,
} from './saved-accounts';
import { FRAME_LEVELS } from './avatar-frames';
import { challengePackId } from './challenge-prize';
import { FREE_WELCOME_CATEGORY } from './free-pack';
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
import PlayerPayoutDetails from './models/player-payout-details';
import AdminActionAudit from './models/admin-action-audit';
import VipMemberState from './models/vip-member-state';
import VipRewardGrant from './models/vip-reward-grant';
import NotificationRead from './models/notification-read';
import RewardDraw from './models/reward-draw';
import RewardBox from './models/reward-box';
import RewardBoxPrize from './models/reward-box-prize';
import PixelPokemon from './models/pixel-pokemon';
import ChallengeStage from './models/challenge-stage';
import ChallengeSchedule from './models/challenge-schedule';
import ChallengeSettings from './models/challenge-settings';
import TierSettings from './models/tier-settings';
import GlobePayDeposit from './models/globepay-deposit';
import GlobePayWithdrawal from './models/globepay-withdrawal';
import ChallengePayout from './models/challenge-payout';
import LedgerEntry from './models/ledger-entry';
import LedgerSequence from './models/ledger-sequence';
import {
  displayId,
  nextSerial,
  sequenceScope,
  countByHandle,
  type LedgerPayload,
  type LedgerType,
} from './ledger';
import PurchaseInvoice from './models/purchase-invoice';
import PurchaseInvoiceLine from './models/purchase-invoice-line';
import StockMovement from './models/stock-movement';
import { pageAll } from '../../api/utils/page-all';
import { positiveIntFromEnv,
  nonNegativeIntFromEnv } from '../../api/utils/rate-limit';
import {
  resolveBuybackRate,
  buybackAmount,
  instantDeadlineMs,
  type BuybackRate,
} from './buyback-rate';
import { consumeExternalSen } from './external-funded';
import { recomputeExternalStamps } from './external-backfill';
import {
  directReferralPctForLevel,
  directCommissionSen,
  teamOverrideSchedule,
} from './referral-commission';
import { levelForSpend } from './vip-ladder';
import { levelsToGrant, rewardsForLevel } from './vip-rewards';
import { fromSen, toSen } from './money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  resolveFxRate,
  DEFAULT_USD_MYR,
  effectiveRate,
  displayMarketPrice,
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
import {
  foldRanges,
  MAX_VOUCHER_MYR,
  type VoucherRange,
} from './voucher-ranges';
import type { VipLevelInput } from './vip-levels-validate';
import type {
  ChallengeRankReward,
  ChallengeStageInput,
  ChallengeSettingsPatch,
  ChallengeSettingsView,
} from './challenge-validate';
import {
  fillTierRanges,
  normalizeTierRanges,
  type TierSettingsView,
} from './tier-settings-validate';
import { getCardStockByHandle } from './card-stock';
import {
  unlockedStages,
  payoutByRank,
  type SettleStage,
  type RankPayout,
} from './challenge-settle';
import { weightedAverageCost } from './inventory-cost';
import type { MedusaContainer } from '@medusajs/framework/types';

// plan-033 playthrough basis: the "post-1b deposited" ledger predicate. Shared
// between creditSummary and walletSummary so the two SQL scans can't drift.
const DEPOSITED_PT_FILTER =
  "reason = 'topup' AND amount > 0 AND external_funded_cents IS NOT NULL";

// Default rolling-24h cashout ceiling, in RM. The per-transaction payout band
// (RM 50 – RM 50,000, globepay-withdrawal.ts) bounds ONE payout; before this
// cap nothing summed prior withdrawals over any window, so a compromised
// account's blast radius was "the whole balance, as fast as the rate limiter
// allows" with no velocity signal to alert on.
//
// The env override is read PER CALL inside withdrawForCashout (never latched at
// module load) so a spec can drive both cap states through one booted app —
// the convention plan 066 established.
const GLOBEPAY_WD_DAILY_MAX_RM_DEFAULT = 50_000;

// Postgres unique-violation detector (SQLSTATE 23505) for the commission
// idempotency index. See settleOpen's commission catch for the exact semantics
// — a 23505 there rejects the whole duplicate open; it does NOT silently no-op.
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '23505';
}

// Cents → customer-facing "RM 12.34" (matches the existing inline formatting
// in this file's error messages).
function rm(cents: number): string {
  return `RM ${(cents / 100).toFixed(2)}`;
}

// Store-facing insufficient-credits message for a pack open: names the price,
// the customer's (available) balance, and the exact shortfall so a newbie with
// RM 3 can see a RM 25 pack needs a RM 22 top-up (sim day-3 LOW, ux-friction).
function insufficientCreditsMessage(
  costCents: number,
  haveCents: number,
): string {
  return (
    `Not enough credits to open this pack. It costs ${rm(costCents)} and ` +
    `you have ${rm(haveCents)} — top up at least ${rm(costCents - haveCents)}.`
  );
}

// Auto-generates CRUD for each model: list/retrieve/create/update/delete<Model>s
// (e.g. listPacks, listCards, listPackOdds, createPulls,
// listCreditTransactions). Card = prize metadata, PackOdds = the weighted
// table (+ per-pack rarity), Pull = the result ledger doubling as the vault,
// CreditTransaction = the site-credit ledger written by buybacks.

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
  /** Signed MYR (RM) decimal (never cents): negative = spend, positive = grant. */
  amount: number;
  reason: CreditMutationReason;
  /** Note (adjustment) / gateway ref (top-up); null otherwise. */
  reference?: string | null;
  /** The pull this credit came from (buyback rows only). */
  pullId?: string | null;
  /** Minimum allowed resulting balance in MYR (RM) (default RM 0 — no overdraft). */
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
  /** Signed MYR (RM) decimal — the open debit (always < 0). */
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

/** The globepay_withdrawal.status domain, mirrored from the model's enum for
 *  the raw-SQL claim below (raw SQL carries no model types). */
type WithdrawalStatus = 'pending' | 'settled' | 'failed' | 'held';


/** One raw `ledger_entry` row as listLedgerEntriesForAdmin reads it. */
export type LedgerEntryRow = {
  id: string;
  display_id: string;
  type: LedgerType;
  customer_id: string;
  occurred_at: string;
  // Raw driver values for the numeric columns — Number()'d at the route
  // boundary, same discipline as every other raw-SQL money read in this file.
  wallet_delta: string | null;
  vault_delta: string | null;
  payload: unknown;
};

// Live card value in USD: FMV × the card's multiplier (default when the row
// carries none). Requires alias `card c`; binds ONE `?`
// (DEFAULT_MARKET_MULTIPLIER). Shared by PULLED_VALUE_USD_SQL's fallback and
// the backfill (which pins exactly this expression).
const LIVE_VALUE_USD_SQL = 'c.market_value * COALESCE(c.market_multiplier, ?)';

// Pulled value of one pull row in USD: the draw-time snapshot when stamped,
// live fallback for pre-backfill rows. Shared by the three pulled-value
// aggregates (leaderboardTop wins CTE, challengeWeekPool, challengeWeekTop)
// so the expression can't drift between boards. Requires aliases `pull pu` /
// `card c` and binds ONE `?`. Snapshot semantics: a stamped pull KEEPS its
// value even if the card row is later deleted (the snapshot outlives the
// LEFT JOIN); an un-stamped one drops to NULL — the pre-snapshot behavior.
const PULLED_VALUE_USD_SQL =
  'COALESCE(pu.recorded_value_usd, ' + LIVE_VALUE_USD_SQL + ')';

// MikroORM bigNumber raw-column shape is {value: string, precision: number}
// with this default precision — mirrored when the backfill hand-writes the
// raw_ twin (see @medusajs/utils BigNumber DEFAULT_PRECISION).
const BIG_NUMBER_RAW_PRECISION = 20;

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
  /** UTC yyyy-mm-dd the draw was settled under — the notification key uses
   *  this rather than recomputing the date in the route, which can disagree
   *  across a midnight boundary. */
  draw_day?: string;
};

/** Why an account may not be deleted yet. The storefront switches on these. */
export type DeleteBlockReason =
  | 'ACCOUNT_FROZEN'
  | 'BALANCE_NOT_ZERO'
  | 'WITHDRAWAL_PENDING'
  | 'DEPOSIT_PENDING'
  | 'CARDS_UNSETTLED'
  | 'DELIVERY_IN_FLIGHT';

// Defensive depth bound for referralSummary's downward fan-out CTE. linkSponsor
// already rejects cycles, so a real tree terminates well before this; the cap
// is belt-and-suspenders against a corrupted edge so COUNT(*) can never loop.
const DOWNSTREAM_DEPTH_CAP = 100;

// The (timezone, reset-day, reset-hour) anchor a challenge-week query filters
// on. weeksBack selects a PAST week: 0 (default) = the running week, 1 = the
// most recently ended week (settlement's window).
type ChallengeWeekAnchor = {
  timezone: string;
  resetDay: number;
  resetHour: number;
  weeksBack?: number;
};

// Shared CTE resolving one challenge week's UTC [start, end) from a
// ChallengeWeekAnchor. Downstream queries append their SELECT and filter
// `pu.rolled_at >= (SELECT start_utc FROM anchor) AND
//  pu.rolled_at <  (SELECT end_utc   FROM anchor)`. Kept in ONE place so the
// community pool, the pull-value ranking, AND settlement can never drift onto
// different week boundaries. Anchor computed via AT TIME ZONE (DST-correct);
// EXTRACT(DOW) uses 0=Sunday…6=Saturday, matching challenge_settings. wkfix:
// if today IS the reset day but before the reset hour, the naive anchor lands
// in the future — step back one week. weeksBack shifts the whole week left in
// LOCAL time (before the AT TIME ZONE conversion), so a DST transition inside
// the shifted week still lands on the wall-clock reset hour. Takes 6 params
// (timezone, resetDay, resetHour, weeksBack, timezone, timezone).
const CHALLENGE_WEEK_ANCHOR_CTE =
  'WITH nowtz AS (SELECT now() AT TIME ZONE ? AS t), ' +
  'wk AS ( ' +
  "  SELECT date_trunc('day', t) " +
  "         - ((EXTRACT(DOW FROM t)::int - ? + 7) % 7) * interval '1 day' " +
  "         + ? * interval '1 hour' AS start_local, t " +
  '    FROM nowtz ' +
  '), wkfix AS ( ' +
  '  SELECT CASE WHEN start_local > t ' +
  "         THEN start_local - interval '7 days' ELSE start_local END " +
  "         - ? * interval '7 days' AS start_local " +
  '    FROM wk ' +
  '), anchor AS ( ' +
  '  SELECT start_local AT TIME ZONE ? AS start_utc, ' +
  "         (start_local + interval '7 days') AT TIME ZONE ? AS end_utc " +
  '    FROM wkfix ' +
  ') ';
// resetDay/resetHour/weeksBack stay NUMBERS — they feed integer arithmetic in
// the CTE, so a string would change the query's typing.
const challengeWeekAnchorParams = (
  w: ChallengeWeekAnchor,
): (string | number)[] => [
  w.timezone,
  w.resetDay,
  w.resetHour,
  w.weeksBack ?? 0,
  w.timezone,
  w.timezone,
];

// Weekly-challenge settlement (spec 2026-07-29) — dependency + result shapes
// for settleChallengeWeek. getStock is injected because physical stock lives
// in Medusa's inventory module, reachable only through the container the JOB
// holds — the module service must stay container-free.
export interface SettleDeps {
  /** Available stock per card HANDLE (job binds getCardStockByHandle). */
  getStock: (handles: string[]) => Promise<Map<string, number | null>>;
  /**
   * Take `qty` units of a card HANDLE out of inventory, returning true when a
   * tracked unit was actually taken (false = untracked product, nothing to
   * count). Injected for the same reason as getStock: inventory lives in
   * Medusa's inventory module, reachable only through the container the JOB
   * holds, and this module service stays container-free.
   *
   * Without it, settlement read stock as a GATE and never reserved, so every
   * winner entitled to the same card re-read the same pre-grant value and all
   * of them were granted — N claims against one physical unit, with the counter
   * still reading 1 and no operator signal. card-stock.ts states the rule the
   * other way round ("a FULFILMENT COUNTER, not a gate"), and the pack-open
   * path already decrements unconditionally for exactly this reason.
   */
  decrementStock?: (handle: string, qty: number) => Promise<boolean>;
  /** Fired after each winner's transaction COMMITS — notifications, operator
   *  warnings. Optional + best-effort (matureDueCommissions' notify
   *  precedent): the module stays container-free, so the JOB supplies it, and
   *  a throw here can never roll back an already-committed payout. Per winner
   *  rather than after the batch, so a later crash cannot permanently drop an
   *  already-paid winner's notification (the next tick's gate skips them). */
  onSettled?: (winner: SettledWinner, weekStartIso: string) => Promise<void>;
}
export interface SettledWinner {
  customerId: string;
  rank: number;
  credits: number;
  cardHandles: string[]; // granted — DISTINCT handles
  cardCount: number; // pulls actually minted (a handle repeats when qty > 1)
  skippedCardIds: string[]; // recorded skipped_no_stock
  /** Granted cards whose inventory units are not taken yet. Taken AFTER
   *  this winner's payout transaction commits — see reserveSettledStock. */
  reservations: { handle: string; qty: number; pullIds: string[] }[];
}
// The frozen decision inputs, written verbatim onto EVERY payout row of a week
// (card rows extend it with qty/pull_ids, the credits row with
// credits_replayed). A later tick REPLAYS this instead of recomputing — see
// settleChallengeWeek.
interface SettleSnapshot {
  pool_myr: number;
  unlocked_stages: number[];
  /** end_utc of the paid week — what the anchor-shift guard interval-tests. */
  week_end: string;
  /** Top-10 customer ids in rank order; index + 1 IS the rank. */
  ranking: string[];
  /**
   * The RESOLVED rank -> payout table, frozen at first settlement.
   *
   * unlocked_stages holds stage NUMBERS, and those numbers index into ONE live,
   * unscoped challenge_stage table that saveChallengeStages whole-set replaces
   * — including from promoteDueChallengeSchedules, which the very same job runs
   * right after settlement. Because weeksBack is 1, the ended week keeps
   * re-settling for about a week afterwards, so a winner whose rank paid nothing
   * under the old ladder (no payout row, therefore not in settledCustomers) was
   * paid from the PROMOTED ladder on a later tick. Freezing the resolved table
   * makes re-settlement deterministic.
   *
   * Optional: snapshots written before this field existed fall back to the live
   * re-read, which is the pre-existing behaviour.
   */
  by_rank?: Record<string, { rank: number; credits: number; cardIds: string[] }>;
}

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
  PlayerPayoutDetails,
  AdminActionAudit,
  VipMemberState,
  VipRewardGrant,
  NotificationRead,
  RewardDraw,
  RewardBox,
  RewardBoxPrize,
  PixelPokemon,
  ChallengeStage,
  ChallengeSchedule,
  ChallengeSettings,
  TierSettings,
  GlobePayDeposit,
  GlobePayWithdrawal,
  ChallengePayout,
  LedgerEntry,
  LedgerSequence,
  PurchaseInvoice,
  PurchaseInvoiceLine,
  StockMovement,
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
      // weight_2/weight_3 ride along with weight: a membership edit recomputes
      // ALL THREE odds sets, so writing only `weight` would leave a
      // materialized set 2/3 resolving to something other than the full total.
      create: {
        pack_id: string;
        card_id: string;
        rarity: OddsRarity;
        weight: number;
        weight_2?: number | null;
        weight_3?: number | null;
        locked: boolean;
      }[];
      remove_ids: string[];
      reweigh: {
        id: string;
        weight: number;
        weight_2?: number | null;
        weight_3?: number | null;
      }[];
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
    // PAGED under the lock — a truncated re-read would miss a card past the cap
    // and let its stale "create" through, doubling weight. Same reason as the
    // pre-read in set-pack-members; both must see the whole pool for a pack
    // that can hold 2000+ card rows.
    const current = await pageAll((opts) =>
      this.listPackOdds({ pack_id: diff.pack_id }, opts, sharedContext),
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
    pull: {
      rolled_at: Date | string;
      revealed_at?: Date | string | null;
      // Forwarded to resolveBuybackRate so a quote through this helper also goes
      // flat once the reveal closed the window — matching the vault + credit
      // paths (CodeRabbit). Null/absent for a fresh open-time quote (window open).
      instant_closed_at?: Date | string | null;
    },
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

  // Lifetime ledger totals (balance + money-in/out + external-funded spend) in
  // ONE SQL aggregate — the exact twin of credit-summary.ts's foldLedgerRow
  // (which stays as the unit-tested oracle; integration test compares them).
  // Rides IDX_credit_transaction_customer_id_created_at. Replaces the paged
  // JS fold that shipped the whole ledger to Node on every wallet/buyback/VIP
  // read (audit 2026-07-07 #5).
  @InjectManager()
  async creditSummary(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    balance: number;
    topupTotal: number;
    spendTotal: number;
    externalFundedSpendTotal: number;
    // VIP turnover basis (MYR): net pack_open spend regardless of funding
    // source — winnings-funded opens count (2026-07-22). Reversals net it down.
    vipSpendTotal: number;
    // Playthrough-basis deposited total (MYR): topups that carry a basis column
    // (external_funded_cents IS NOT NULL), grandfathering pre-1b deposits out —
    // the SAME filter walletSummary's deposited_cents uses (plan 033). This is
    // NOT topupTotal (which counts every positive topup). walletSummary reuses
    // this so the playthrough basis is defined in exactly one SQL query.
    depositedPlaythroughTotal: number;
  }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const rows = await em.execute<
      {
        balance_cents: string | null;
        topup_cents: string | null;
        spend_cents: string | null;
        ext_spend_cents: string | null;
        vip_spend_cents: string | null;
        deposited_pt_cents: string | null;
      }[]
    >(
      'SELECT ' +
        '  COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents, ' +
        "  COALESCE(SUM(CASE WHEN reason = 'topup' AND amount > 0 THEN ROUND(amount * 100) ELSE 0 END), 0)::bigint AS topup_cents, " +
        '  COALESCE(SUM(CASE WHEN amount < 0 THEN ROUND(-amount * 100) ELSE 0 END), 0)::bigint AS spend_cents, ' +
        "  COALESCE(SUM(CASE WHEN reason = 'pack_open' THEN -external_funded_cents ELSE 0 END), 0)::bigint AS ext_spend_cents, " +
        "  COALESCE(SUM(CASE WHEN reason = 'pack_open' THEN ROUND(-amount * 100) ELSE 0 END), 0)::bigint AS vip_spend_cents, " +
        `  COALESCE(SUM(CASE WHEN ${DEPOSITED_PT_FILTER} THEN ROUND(amount * 100) ELSE 0 END), 0)::bigint AS deposited_pt_cents ` +
        'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
      [customerId],
    );
    const r = rows[0];
    return {
      balance: Number(r?.balance_cents ?? 0) / 100,
      topupTotal: Number(r?.topup_cents ?? 0) / 100,
      spendTotal: Number(r?.spend_cents ?? 0) / 100,
      externalFundedSpendTotal: Number(r?.ext_spend_cents ?? 0) / 100,
      vipSpendTotal: Number(r?.vip_spend_cents ?? 0) / 100,
      depositedPlaythroughTotal: Number(r?.deposited_pt_cents ?? 0) / 100,
    };
  }

  // Monthly pack_open spend for one customer (MYR), newest first, capped at 24
  // months. Months are bucketed in Asia/Kuala_Lumpur — every date boundary in
  // this project is MYT, so an open at 17:00Z on the 28th belongs to the NEXT
  // month. Months with no pack_open activity are omitted entirely (the HAVING),
  // so a top-up-only month never shows up as a zero row. Same integer-cent
  // idiom and index (customer_id, created_at) as creditSummary.
  //
  // KNOWN WART — a CROSS-MONTH reversal distorts BOTH months: reverseOpen writes
  // its refund as a positive `pack_open` row stamped with the reversal's own
  // created_at, so a March open reversed in April leaves March overstated and
  // April negative. (Unlike creditSummary.vipSpendTotal, where the same rows net
  // down one scalar and the distortion cancels.) Upgrade path when this matters:
  // bucket a reversal by the reversed row's created_at, joining on the
  // credit_transaction.source_transaction_id both rows already carry.
  @InjectManager()
  async spendReportForCustomer(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ period: string; spend: number }[]> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const rows = await em.execute<{ period: string; spend_cents: string }[]>(
      "SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'Asia/Kuala_Lumpur'), 'YYYY-MM') AS period, " +
        "  COALESCE(SUM(CASE WHEN reason = 'pack_open' THEN ROUND(-amount * 100) ELSE 0 END), 0)::bigint AS spend_cents " +
        'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL ' +
        "GROUP BY 1 HAVING SUM(CASE WHEN reason = 'pack_open' THEN 1 ELSE 0 END) > 0 ORDER BY 1 DESC LIMIT 24",
      [customerId],
    );
    return rows.map((r) => ({
      period: r.period,
      spend: Number(r.spend_cents) / 100,
    }));
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
    /** The row's stored (gateway/charge) reference — on a replay this is the
     * ORIGINAL charge reference, so callers can echo it instead of a fresh
     * one that would read as a second successful charge (sim P2-4). */
    reference: string | null;
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
          reference: existing.reference ?? null,
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
          ? insufficientCreditsMessage(-deltaCents, beforeCents - floorCents)
          : `Deduction exceeds the customer's balance (RM ${(
              beforeCents / 100
            ).toFixed(2)}) — the balance cannot go below RM ${(
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
      reference: input.reference ?? null,
    };
  }

  // Wraps mutateCreditAtomic with the paired TP ledger row, same transaction
  // (POLYCARD-BACK §5.3). ref_id = the credit_transaction's own id, so the
  // Wallet-tab join (Task 9) is a plain equality on credit_transaction.id.
  //
  // ledgerPaymentMethod/ledgerGatewayRef default to the mock gateway so the
  // original caller is untouched; the GlobePay365 callback and its
  // reconciliation sweep pass the real method (BQR/OB) and their transaction
  // id. Those two share ONE idempotency anchor, so a callback racing the sweep
  // collapses to a single credit — and since refId is that credit's id, to a
  // single ledger row.
  @InjectTransactionManager()
  async topUpCreditsWithLedger(
    input: CreditMutationInput & {
      ledgerPaymentMethod?: string;
      ledgerGatewayRef?: string | null;
    },
    @MedusaContext() sharedContext: Context = {},
  ): ReturnType<PacksModuleService['mutateCreditAtomic']> {
    const result = await this.mutateCreditAtomic(input, sharedContext);
    if (!result.replayed) {
      await this.recordLedgerEntry(
        {
          type: 'TP',
          customerId: input.customerId,
          refId: result.id,
          walletDelta: result.amount,
          vaultDelta: null,
          payload: {
            type: 'TP',
            payment_method: input.ledgerPaymentMethod ?? 'mock',
            gateway_ref:
              input.ledgerGatewayRef === undefined
                ? result.reference
                : input.ledgerGatewayRef,
          },
        },
        sharedContext,
      );
    }
    return result;
  }

  // The withdrawal counterpart: every balance move on the payout path writes a
  // WD row in the SAME transaction. Debit is negative, refund positive, so
  // Σ(ledger) follows the balance through the whole payout lifecycle — without
  // this, arming payouts breaks the conservation invariant asserted by
  // integration-tests/http/ledger-conservation.spec.ts.
  //
  // A replayed credit writes nothing: the refund anchors are idempotent, so a
  // callback and the sweep both refunding one failed payout produce one credit
  // and one ledger row.
  @InjectTransactionManager()
  async withdrawCreditsWithLedger(
    input: CreditMutationInput & {
      ledger: {
        outcome: 'requested' | 'refunded';
        bankCode: string | null;
        accountNumber: string | null;
        gatewayRef: string | null;
      };
    },
    @MedusaContext() sharedContext: Context = {},
  ): ReturnType<PacksModuleService['mutateCreditAtomic']> {
    const result = await this.mutateCreditAtomic(input, sharedContext);
    if (!result.replayed) {
      await this.recordLedgerEntry(
        {
          type: 'WD',
          customerId: input.customerId,
          refId: result.id,
          walletDelta: result.amount,
          vaultDelta: null,
          payload: {
            type: 'WD',
            outcome: input.ledger.outcome,
            bank_code: input.ledger.bankCode,
            // Last 4 only — the ledger is a customer- and operator-visible
            // surface; the full number stays on globepay_withdrawal.
            account_last4: input.ledger.accountNumber
              ? input.ledger.accountNumber.slice(-4)
              : null,
            gateway_ref: input.ledger.gatewayRef,
          },
        },
        sharedContext,
      );
    }
    return result;
  }

  // The ONE writer of a cashout DEBIT: the destination lookup, the withdrawal
  // gate and the debit, as a single serialized unit.
  //
  // Why the gate cannot merely PRECEDE the debit (it used to, in
  // globepay-withdrawal.ts, with no lock held across the two): `floor: 0` in
  // mutateCreditAtomic guards the RAW balance. It knows nothing about `locked`
  // — walletSummary's withdrawable is `balance − locked` (minus the freeze flag
  // and the playthrough gate), and the floor cannot see any of that. So N
  // concurrent POST /store/credits/withdraw requests all read the SAME
  // withdrawable, all pass the policy check, and all debit, bounded only by the
  // raw balance: a customer holding unmatured or suspended commission credits
  // could move up to `locked` more than they are entitled to, out to a bank,
  // after which the reversal and auto-freeze machinery has nothing left to claw
  // back. The rate limiter permits a 5-request burst per 10s, so that
  // concurrency is reachable. Holding `credit:<customer>` across the read AND
  // the write is what makes the policy layer atomic; floor 0 stays underneath
  // as the raw-overdraft backstop.
  //
  // Rejected alternative: making `floor` mean `balance − locked` globally.
  // Packs are deliberately spendable from the raw balance (walletSummary:
  // "Spending on packs stays unrestricted either way — the gate only limits
  // cashout"), so that would change what players can spend on packs. `floor`
  // and `withdrawable` mean different things and always will.
  //
  // Re-entrancy: withdrawCreditsWithLedger → mutateCreditAtomic re-acquires
  // this SAME advisory key below. Postgres advisory locks are re-entrant per
  // session, so that is a no-op. The invariant it must not break is at most one
  // DISTINCT `credit:` key per transaction (see matureDueCommissions) — this
  // method only ever takes its own customer's.
  @InjectTransactionManager()
  async withdrawForCashout(
    input: {
      customerId: string;
      /** POSITIVE RM to withdraw; the ledger debit is written as −amount. */
      amount: number;
      /** Our payout reference — also the ledger `reference` and gateway ref. */
      merchantTransactionId: string;
      idempotencyReference: string;
      /** The SAVED destination the customer picked. Never bank details: the
       *  bank code and account number are looked up from their own saved list
       *  below, so a request body cannot name where the money goes. */
      accountId: unknown;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<
    Awaited<ReturnType<PacksModuleService['mutateCreditAtomic']>> & {
      /** What the gateway must be told to pay — resolved here, under the lock,
       *  so the caller cannot submit a destination this method never approved. */
      destination: SavedBankAccount;
    }
  > {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;

    // Sign guard. This method inverts the caller's convention (positive RM in,
    // negative delta out), so a caller passing an already-negated amount would
    // silently CREDIT the customer instead of debiting them. Fail loud — the
    // same reasoning as mutateCreditAtomic's own topup/pack_open sign
    // invariants.
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Withdrawal amount must be greater than 0.',
      );
    }

    // 1) Serialize this customer's credit mutations across the WHOLE gate +
    //    debit. Same idiom and same key as mutateCreditAtomic.
    //
    //    Note what this widened: the lock now spans walletSummary (~4 queries)
    //    + the cap scan + the debit, where it used to cover the debit alone.
    //    That is fine at withdrawal volume — payouts are rare, per-customer, and
    //    human-initiated — but it is a real assumption. A future high-volume
    //    path must not inherit it without re-measuring; only mutations for THIS
    //    customer contend, so the blast radius is one account either way.
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${input.customerId}`,
    ]);

    // 1a) THE ROW MUST STILL BE OPEN. Read under the lock, before anything
    //     else, and the debit half of the pact with
    //     claimWithdrawalAgainstDebit below — see that method for the full
    //     argument. In short: globepay-withdrawal.ts commits the row at step 1
    //     and debits here at step 2, so an admin approve/deny can land in
    //     between and close a row this call is about to debit. That admin
    //     close takes THIS key first and only closes a row it read as
    //     undebited, so whichever transaction commits first is seen by the
    //     other: if the close won, this read returns 'failed' and we refuse
    //     rather than strand a debit nothing would ever refund.
    //
    //     DEPENDS ON READ COMMITTED, which is the default and what every
    //     caller gets today (@InjectTransactionManager forwards
    //     `isolationLevel` from the caller's context, and these calls pass
    //     none). Under REPEATABLE READ this read would use the snapshot taken
    //     at the pg_advisory_xact_lock statement — from BEFORE the admin
    //     close committed — see 'held', and debit anyway. Do not compose this
    //     method into a context carrying a stricter isolation level.
    //
    //     Fail closed on a missing row too — a debit with no row to hang the
    //     callback on is unresolvable by definition.
    //
    //     'pending' is checked alongside 'held' because this guard is not
    //     held-specific: any closed row must not be debited.
    const [openRow] = await em.execute<{ status: string }[]>(
      'SELECT status FROM globepay_withdrawal ' +
        'WHERE merchant_transaction_id = ? AND deleted_at IS NULL',
      [input.merchantTransactionId],
    );
    if (openRow?.status !== 'pending' && openRow?.status !== 'held') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'This withdrawal is no longer open, so nothing was debited. Start a new one.',
      );
    }

    // 2) The DESTINATION, resolved here rather than taken from the request.
    //    Ownership is structural: the list read is keyed on input.customerId
    //    (which comes from the verified token), so an id belonging to another
    //    customer simply is not in it and lands on the "Select a saved bank
    //    account." refusal — before the gate and before any debit.
    //
    //    The read runs on `em` — THIS method's transaction manager — so it is
    //    the same connection and the same transaction as the advisory lock
    //    above and the debit below, and it issues the same
    //    `SELECT metadata FROM customer` that mutateCustomerMetadata reads the
    //    blob with. Routing it through the customer module instead would put it
    //    on a second connection that the lock has no relationship with.
    //
    //    What "under the lock" does and does not buy here, precisely: this read
    //    runs after pg_advisory_xact_lock and before the debit, so no two
    //    withdrawals for this customer can interleave around it. It does NOT
    //    exclude a concurrent saved-accounts write — that path serializes on
    //    `metadata:<customer>`, a different key, and mutateCustomerMetadata may
    //    not be composed into a `credit:`-locked transaction. Nor would being
    //    in-transaction exclude it on its own: under READ COMMITTED each
    //    statement takes a fresh snapshot, so this SELECT sees whatever last
    //    committed either way.
    //
    //    It does not need to. savedBankAccountId is derived from
    //    (bankCode, accountNumber), so a concurrent write can add an entry,
    //    delete one, or relabel one — it can never repoint an id at a different
    //    bank account. The worst interleaving pays a destination the customer
    //    owned and had cooled off, deleted moments ago. The id pins WHERE the
    //    money goes; the lock pins WHEN.
    //
    //    PRECEDENCE, since it is a deliberate choice and not the order the
    //    wallet gate uses: a bad destination outranks a bad wallet. A frozen
    //    account naming an un-cooled destination hears about the destination,
    //    not the freeze. That is the quieter answer to someone holding a stolen
    //    token, and it keeps this method and globepay-withdrawal.ts's precheck
    //    in the same order. withdrawable.ts's own precedence rule (freeze
    //    outranks playthrough outranks the cap) is untouched — it orders the
    //    three WALLET refusals against each other, all of which sit below this.
    const destination = resolveWithdrawalDestination({
      accounts: await loadSavedBankAccounts(em, input.customerId),
      accountId: input.accountId,
    });

    // 3) The withdrawal gate, read INSIDE the lock (withdrawable.ts's own
    //    invariant: "the cashout writer MUST route through this").
    //    walletSummary folds THREE limits into one number: the freeze flag
    //    (frozen accounts withdraw nothing — it is the fraud-response tool),
    //    locked unmatured commissions, and the playthrough gate (deposits must
    //    be spent on packs before they can leave to a bank — the
    //    anti-laundering rule). Threading sharedContext is what makes the read
    //    see this locked transaction rather than a separate connection.
    const wallet = await this.walletSummary(
      input.customerId,
      undefined,
      sharedContext,
    );
    //    THIS is the authoritative gate — the decision that makes the payout
    //    safe. globepay-withdrawal.ts calls the same helper unlocked before
    //    writing its row, but only to avoid leaving debris on a refusal that is
    //    already certain; it decides nothing.
    const gateError = withdrawalGateError(wallet, input.amount);
    if (gateError) throw gateError;

    // 4) Rolling-24h VALUE cap, summed under the same lock so the sum and the
    //    debit cannot interleave either.
    //
    //    `pending` and `settled` both moved (or are still moving) money;
    //    `held` does too — the debit already posted (see
    //    startGlobePayWithdrawal), the row is merely parked for admin approval
    //    instead of being sent to the gateway, and the money stays out of the
    //    balance until a refund (admin deny) puts it back. So a held payout
    //    consumes the customer's daily blast radius exactly like a submitted
    //    one. `failed` alone did not move money — a refused or refunded
    //    payout must never consume the customer's cap. Those four are the
    //    entire domain of the column's CHECK constraint
    //    (Migration20260722170000, widened to add `held` by
    //    Migration20260811220000), which also supplies the (status,
    //    created_at) and (customer_id) partial indexes this scan uses.
    //
    //    The just-created row is EXCLUDED by merchant_transaction_id:
    //    globepay-withdrawal.ts writes it with its final status (`pending` or
    //    `held`) BEFORE calling this method (the callback echoes only
    //    MerchantTransactionId, so that row is the only way back to the
    //    customer), so an unfiltered sum would count this very attempt
    //    against its own cap and refuse every withdrawal above half the
    //    ceiling.
    //
    //    A CONCURRENT attempt's row does still count, though: request B writes
    //    its own row before it takes this lock, so A's sum includes B
    //    even if B goes on to fail the gate and flip to `failed`. That
    //    over-counts, never under-counts, and it self-heals as the 24h window
    //    slides — the fail-closed direction is the right default for a cap
    //    whose job is bounding blast radius.
    // nonNegativeIntFromEnv, NOT positiveIntFromEnv: setting this cap to 0 is
    // the operator's stop lever for money-out during an incident, and the
    // positive-only parser routed 0 to the DEFAULT — silently leaving
    // withdrawals wide open at RM 50,000 while the logs said the value was
    // ignored.
    const capCents =
      nonNegativeIntFromEnv(
        'GLOBEPAY_WD_DAILY_MAX_RM',
        GLOBEPAY_WD_DAILY_MAX_RM_DEFAULT,
      ) * 100;
    const capRows = await em.execute<{ sum_cents: string | null }[]>(
      'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS sum_cents ' +
        'FROM globepay_withdrawal ' +
        'WHERE customer_id = ? AND deleted_at IS NULL ' +
        "AND status IN ('pending', 'settled', 'held') " +
        "AND created_at > now() - interval '24 hours' " +
        'AND merchant_transaction_id <> ?',
      [input.customerId, input.merchantTransactionId],
    );
    // Integer cents throughout — the ledger's unit convention; comparing RM
    // floats here would drift against the amounts actually written.
    const windowCents = Number(capRows[0]?.sum_cents ?? 0);
    const amountCents = Math.round(input.amount * 100);
    if (windowCents + amountCents > capCents) {
      // Clamped at 0: a customer already over the ceiling (an operator
      // adjustment, or a lowered env) must not be told they may withdraw a
      // NEGATIVE amount more today.
      const remaining = Math.max(0, capCents - windowCents) / 100;
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Daily withdrawal limit reached. You can withdraw RM ${remaining.toFixed(2)} more today.`,
      );
    }

    // 5) Debit on the SAME context, so it joins this locked transaction instead
    //    of opening its own.
    //
    //    The cap above runs BEFORE mutateCreditAtomic's idempotent-replay
    //    check, so in principle a genuine replay could be cap-rejected. Not
    //    reachable today: newMerchantTransactionId() mints a fresh reference
    //    per attempt, so no two calls here ever share an idempotencyReference.
    const debit = await this.withdrawCreditsWithLedger(
      {
        customerId: input.customerId,
        amount: -input.amount,
        reason: 'cashout',
        reference: input.merchantTransactionId,
        idempotencyReference: input.idempotencyReference,
        floor: 0,
        ledger: {
          outcome: 'requested',
          bankCode: destination.bankCode,
          accountNumber: destination.accountNumber,
          // Their id does not exist yet — SubmitWithdrawal has not run.
          gatewayRef: input.merchantTransactionId,
        },
      },
      sharedContext,
    );
    return { ...debit, destination };
  }

  /**
   * ATOMIC STATUS CLAIM on one globepay_withdrawal row — the mutex behind the
   * admin approve/deny routes (plan 094).
   *
   * ONE conditional UPDATE, and that is the whole point: Postgres re-evaluates
   * the predicate against committed state AFTER the row lock is released, so
   * of two concurrent claims exactly one matches a row and the other matches
   * none. `RETURNING id` is that answer. `true` means THIS caller moved the
   * row and owns whatever follows it (a gateway submit, a refund); `false`
   * means someone else already did, and the caller must not act.
   *
   * Do NOT reimplement this with `updateGlobePayWithdrawals({ selector, data
   * })`. It type-checks and hands back an array, so `length === 0` reads like
   * the same guard, but the generated service resolves the selector with a
   * find-then-write and takes no row lock: two concurrent approves — a
   * double-clicked button is the realistic trigger — both read 'held', both
   * see one row, and both submit. That is a duplicate payout to a real bank
   * account. Raw SQL for the same reason the rolling-24h cap above uses it:
   * the module-service layer has no conditional-write primitive.
   */
  @InjectTransactionManager()
  async claimGlobePayWithdrawalStatus(
    input: {
      id: string;
      /** Statuses the row may be claimed FROM. A row in any other status is
       *  left untouched and the claim answers false. */
      from: readonly WithdrawalStatus[];
      to: WithdrawalStatus;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<boolean> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    // One placeholder per accepted status. The list is ours (never a request
    // value) and it stays BOUND rather than interpolated regardless.
    const accepted = input.from.map(() => '?').join(', ');
    const rows = await em.execute<{ id: string }[]>(
      'UPDATE globepay_withdrawal SET status = ?, updated_at = now() ' +
        `WHERE id = ? AND status IN (${accepted}) AND deleted_at IS NULL ` +
        'RETURNING id',
      [input.to, input.id, ...input.from],
    );
    return rows.length === 1;
  }

  /**
   * The admin approve/deny claim, SERIALIZED AGAINST THE DEBIT — the whole
   * reason this exists on top of claimGlobePayWithdrawalStatus (plan 094
   * review fix, CodeRabbit).
   *
   * THE WINDOW. startGlobePayWithdrawal commits the withdrawal row at step 1
   * and debits at step 2, so a committed 'held' row with no debit yet is a
   * normal, expected state — not only a crash. An admin acting inside that
   * window sees "no debit" and cannot tell it from "no debit EVER": close the
   * row on the first reading and the debit that lands a moment later is
   * stranded for good, because the reconcile sweep selects 'pending' only and
   * never revisits a 'held' or 'failed' row.
   *
   * WHY NOT A TIMER. This used to be an elapsed-time gate
   * (GLOBEPAY_WD_HELD_DEBIT_GRACE_MS): wait 60s and a still-running debit was
   * declared impossible, on the grounds that
   * idle_in_transaction_session_timeout would have killed it. That reasoning
   * was FALSE. That timeout only fires on a session idle BETWEEN statements;
   * a transaction blocked inside `SELECT pg_advisory_xact_lock(...)` is
   * executing a statement, is reported `active` with wait_event `advisory`,
   * and is never killed by it. Nothing in the driver config bounds a lock
   * wait (utils/db-driver-options.ts cannot even set lock_timeout), so no
   * amount of elapsed time proves a debit has finished. Only the lock does.
   *
   * THE PACT, both halves of which are required:
   *   - here: take `credit:<customer>`, read the debit, and claim the row —
   *     all in ONE transaction, so the answer cannot go stale between the
   *     read and the write;
   *   - in withdrawForCashout (step 1a): take the same key, re-read the row,
   *     and refuse to debit a row that is no longer open.
   *
   * The lock alone would NOT be enough. A debit queued BEHIND this claim is
   * invisible to the read here, so without step 1a it would go on to commit
   * against a row this call had just closed. With both halves, the two
   * critical sections are mutually exclusive and each reads what the other
   * wrote: whichever commits first wins, and the loser observes it.
   *
   * @returns `debited` — whether a debit exists for this payout, decided
   * under the lock, so a caller may act on `false` as "no debit will ever
   * land". `claimed` — whether THIS caller moved the row (see
   * claimGlobePayWithdrawalStatus).
   */
  @InjectTransactionManager()
  async claimWithdrawalAgainstDebit(
    input: {
      id: string;
      customerId: string;
      /** withdrawalIdempotencyReference(customerId, merchantTransactionId) —
       *  the `wd:` anchor the debit is stored under. */
      debitReference: string;
      from: readonly WithdrawalStatus[];
      /** Where the row goes when a debit EXISTS. An UNDEBITED row is always
       *  closed 'failed' instead: there is no other honest destination for a
       *  payout that never took the customer's money. */
      to: WithdrawalStatus;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ debited: boolean; claimed: boolean }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;

    // BOUND THE WAIT, admin-side only. Nothing else caps a lock wait —
    // utils/db-driver-options.ts cannot set lock_timeout (see its comment),
    // and idle_in_transaction_session_timeout does not apply to a session
    // blocked inside a statement. Without this an admin click on a customer
    // with a long-running credit mutation hangs indefinitely, holding one of
    // the five pooled connections. Timing out is HARMLESS here: the statement
    // error aborts the transaction, so the row is untouched and the operator
    // clicks again. SET LOCAL, so it dies with this transaction rather than
    // leaking onto the pooled connection's next borrower.
    //
    // Deliberately NOT applied to withdrawForCashout: there a timeout turns a
    // merely slow withdrawal into a customer-facing error, and that call has
    // no equivalent "try again, nothing moved" affordance.
    await em.execute("SET LOCAL lock_timeout = '5s'");

    // The try spans the WHOLE locked section, not just the advisory lock.
    // SET LOCAL applies to every statement left in this transaction, and the
    // claim's `UPDATE … RETURNING id` takes a ROW lock that can time out too
    // — wrapping only the acquisition would let that one reach the operator
    // as a raw `canceling statement due to lock timeout`, which is exactly
    // what the translation below exists to prevent, one statement later.
    try {
      // Same key and same idiom as mutateCreditAtomic and withdrawForCashout.
      // Re-entrant per session, so a refund composed onto this context later
      // re-taking it is a no-op.
      await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `credit:${input.customerId}`,
      ]);

      // The same read the routes did unlocked before this method existed —
      // deliberately the generated lister, not new raw SQL, so its soft-delete
      // semantics stay identical to the shipped behaviour. sharedContext is
      // threaded so it rides THIS locked transaction.
      const [debitRow] = await this.listCreditTransactions(
        {
          customer_id: input.customerId,
          source_transaction_id: input.debitReference,
        },
        { take: 1 },
        sharedContext,
      );
      const debited = Boolean(debitRow);

      // In the SAME transaction, so the decision and the row move commit
      // together. @InjectTransactionManager re-uses a context that already
      // carries a transactionManager instead of opening a second transaction —
      // if it did open one, the claim would land outside the lock and the whole
      // pact above would silently lapse.
      const claimed = await this.claimGlobePayWithdrawalStatus(
        { id: input.id, from: input.from, to: debited ? input.to : 'failed' },
        sharedContext,
      );
      return { debited, claimed };
    } catch (error) {
      // ONLY 55P03 (lock_not_available) is translated. Anything else — a
      // dropped connection, a constraint violation — must surface as itself
      // rather than be relabelled "someone else is busy", which would send an
      // operator chasing contention that never happened. Never swallowed into
      // a fabricated {debited:false}: that would close the row on a reading we
      // never took.
      if ((error as { code?: string })?.code !== '55P03') throw error;
      throw new MedusaError(
        MedusaError.Types.CONFLICT,
        'Another balance operation for this customer is in progress. Nothing was changed — try again in a moment.',
      );
    }
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
      const raw = Number(
        (grant.payload as { amount_myr?: number } | null)?.amount_myr ?? 0,
      );
      // The payload is SNAPSHOTTED at grant time, so the admin-side cap in
      // voucher-ranges.ts does not bind it: a grant minted while the ladder held
      // a larger figure stays claimable at that figure, and
      // Migration20260805000000 deliberately left already-minted grants
      // claimable after zeroing the ladder. mutateCreditAtomic sign-checks only
      // topup and pack_open, so 'voucher_claim' reached the ledger unbounded.
      //
      // Clamp rather than refuse: the grant is a real obligation and refusing it
      // outright would strand a customer's legitimate reward. Clamping pays what
      // the operator's own ceiling allows and records the discrepancy.
      if (!Number.isFinite(raw) || raw < 0) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Voucher grant ${grantId} carries a non-payable amount.`,
        );
      }
      amountMyr = Math.min(raw, MAX_VOUCHER_MYR);
      if (amountMyr !== raw) {
        // eslint-disable-next-line no-console
        console.warn(
          '[claimReward] voucher grant above the ceiling — paying the cap',
          { grant_id: grantId, requested_myr: raw, paid_myr: amountMyr },
        );
      }
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
      // freeUnlocked is irrelevant on this path: the reward gate returns first
      // for the only shape that ships here, and a source='free' pull is
      // 'invalid' whichever verdict it earns. No hasPaidOpen read under the
      // lock.
      true,
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

  // Collapses request-delivery's three writes (order, items, pull flip) plus
  // the paired OD ledger row into ONE transaction (POLYCARD-BACK §5.3:
  // "vault - at order CREATE"). Replaces the step's previous three-stage
  // manual try/catch undo — a failure partway through this method rolls back
  // via the transaction itself; the step's own compensation only needs to
  // undo the WHOLE thing if a LATER workflow step fails afterward.
  //
  // Fires at CREATE, not at any later admin ship/deliver advance: vaultValue-
  // ForPulls/playersOverview both key liability off status='vaulted', and
  // transitionPullStatus flips vaulted -> delivering right here (below) —
  // NOT at 'shipped'. A pull that's already 'delivering' has already left
  // the counted pool for the whole requested/processed/ready_to_ship/shipped
  // window, so the ledger row must match that same instant or it overstates
  // vault liability for every pending order.
  //
  // input.fx is RESOLVED BY THE CALLER (request-delivery.ts, matching
  // record-pull.ts:32's precedent) — never resolveFxRate(this) in here.
  // resolveFxRate has no sharedContext, so calling it inside this
  // @InjectTransactionManager() method would acquire a SECOND pool
  // connection while this one already holds the write transaction — the
  // exact KnexTimeoutError "pool is probably full" shape Task 7 fixed for
  // the SP writer (service.ts recordPullsWithLedger).
  @InjectTransactionManager()
  async createDeliveryOrderWithLedger(
    input: {
      customerId: string;
      snapshot: AddressSnapshot;
      pullIds: string[];
      fx: number;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ orderId: string; itemIds: string[] }> {
    const [order] = await this.createDeliveryOrders(
      [
        {
          customer_id: input.customerId,
          status: 'requested' as const,
          ...input.snapshot,
        },
      ],
      sharedContext,
    );
    const items = await this.createDeliveryOrderItems(
      input.pullIds.map((pull_id) => ({
        delivery_order_id: order.id,
        pull_id,
      })),
      sharedContext,
    );
    await this.transitionPullStatus(
      { ids: input.pullIds, from: 'vaulted', to: 'delivering' },
      sharedContext,
    );

    // ONE listPulls call feeds both the value sum and the payload tally —
    // vaultValueForPulls takes the rows, not the ids, so this isn't fetched twice.
    const pulls = await this.listPulls(
      { id: input.pullIds },
      { take: input.pullIds.length },
      sharedContext,
    );
    const vaultDelta = await this.vaultValueForPulls(
      pulls,
      input.fx,
      sharedContext,
    );
    await this.recordLedgerEntry(
      {
        type: 'OD',
        customerId: input.customerId,
        refId: order.id,
        walletDelta: 0,
        vaultDelta: -vaultDelta,
        payload: {
          type: 'OD',
          handles: countByHandle(pulls.map((p) => p.card_id)),
          status: 'requested',
        },
      },
      sharedContext,
    );
    return { orderId: order.id, itemIds: items.map((i) => i.id) };
  }

  // The OD debit's value: Σ displayMarketPrice(card.market_value, fx,
  // multiplier) over the given pulls' cards. ONE caller —
  // createDeliveryOrderWithLedger — because an order is valued exactly once,
  // at create; the cancel arm reverses that stored amount rather than
  // re-pricing the cards at a later instant. Takes already-fetched pull rows
  // (never re-queries) and an already-resolved `fx` (never resolveFxRate(this)
  // — see createDeliveryOrderWithLedger's comment above; the same pool-
  // exhaustion hazard applies to any future caller). listCards/listPulls calls
  // elsewhere in this file thread sharedContext through and are safe — only
  // the fx resolver drops it.
  private async vaultValueForPulls(
    pulls: { card_id: string }[],
    fx: number,
    sharedContext: Context,
  ): Promise<number> {
    const handles = [...new Set(pulls.map((p) => p.card_id))];
    if (handles.length === 0) return 0;
    const cards = await this.listCards(
      { handle: handles },
      { take: handles.length },
      sharedContext,
    );
    const byHandle = new Map(cards.map((c) => [c.handle, c]));
    const sum = pulls.reduce((total, p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return total;
      return (
        total +
        displayMarketPrice(
          Number(card.market_value),
          fx,
          Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
        )
      );
    }, 0);
    return Math.round(sum * 100) / 100;
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

  // Player disable switch (POLYCARD-BACK §4.2): blocks LOGIN/session use —
  // orthogonal to `frozen` (funds lock), so neither flag reads or writes the
  // other's columns. One row per customer, lazy-created like the freeze path.
  // Takes the SAME advisory key as the freeze path — it guards the same
  // customer_account_state row, whose customer_id is unique, against a
  // duplicate list-then-create. State + audit share one transaction: an
  // undisclosed disable (no audit row) is not an acceptable partial failure.
  @InjectTransactionManager()
  async setAccountDisabled(
    input: {
      customerId: string;
      adminId: string;
      disabled: boolean;
      reason: string;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ disabled: boolean }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${input.customerId}`,
    ]);
    const [existing] = await this.listCustomerAccountStates(
      { customer_id: input.customerId },
      { take: 1 },
      sharedContext,
    );
    const patch = {
      disabled: input.disabled,
      disabled_reason: input.disabled ? input.reason : null,
      disabled_by: input.disabled ? input.adminId : null,
      disabled_at: input.disabled ? new Date() : null,
    };
    if (existing) {
      await this.updateCustomerAccountStates(
        { selector: { id: existing.id }, data: patch },
        sharedContext,
      );
    } else {
      await this.createCustomerAccountStates(
        [{ customer_id: input.customerId, ...patch }],
        sharedContext,
      );
    }
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'customer',
          entity_id: input.customerId,
          action: input.disabled ? 'disable' : 'enable',
          before: { disabled: existing?.disabled ?? false },
          after: { disabled: input.disabled },
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return { disabled: input.disabled };
  }

  // Has this account ever completed SMS verification? One read, mirroring
  // isAccountDisabled. The stateless OTP proof cannot answer this (10m TTL),
  // and `customer.phone` is not a proxy for it — see the model's comment.
  @InjectManager()
  async isPhoneVerified(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<boolean> {
    const [state] = await this.listCustomerAccountStates(
      { customer_id: customerId },
      { select: ['phone_verified_at'], take: 1 },
      sharedContext,
    );
    return Boolean(state?.phone_verified_at);
  }

  // Stamp the account as phone-verified. Called from the two paths that can
  // only be reached WITH a valid OTP proof: the phone-change route, and the
  // customer.created subscriber (requireSignupPhoneProof middleware has already
  // rejected an unproven signup phone by the time the customer row exists).
  //
  // Idempotent and first-write-wins: re-verifying a number later must not move
  // the timestamp, because it records when the account was first trusted.
  // Same advisory key as the other account-state upserts, so two concurrent
  // first-writes can't race the unique customer_id to a 23505.
  @InjectTransactionManager()
  async markPhoneVerified(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);
    const [existing] = await this.listCustomerAccountStates(
      { customer_id: customerId },
      { take: 1 },
      sharedContext,
    );
    if (existing?.phone_verified_at) return;
    if (existing) {
      await this.updateCustomerAccountStates(
        {
          selector: { id: existing.id },
          data: { phone_verified_at: new Date() },
        },
        sharedContext,
      );
    } else {
      await this.createCustomerAccountStates(
        [{ customer_id: customerId, phone_verified_at: new Date() }],
        sharedContext,
      );
    }
  }

  // Stamp the account as eligible for the one free welcome pack (spec
  // docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md). Called from
  // the customer.created subscriber, which is why only accounts registered
  // after the feature shipped ever carry it — that IS the "new registrations
  // only" rule, with no date cutoff anywhere.
  //
  // markPhoneVerified's shape, for markPhoneVerified's reasons: idempotent and
  // first-write-wins (a re-stamp must not move the timestamp), under the SAME
  // `credit:` advisory key as every other account-state upsert so two
  // concurrent first-writes can't race the unique customer_id to a 23505.
  @InjectTransactionManager()
  async markFreePackAvailable(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);
    const [existing] = await this.listCustomerAccountStates(
      { customer_id: customerId },
      { take: 1 },
      sharedContext,
    );
    if (existing?.free_pack_available_at) return;
    if (existing) {
      await this.updateCustomerAccountStates(
        {
          selector: { id: existing.id },
          data: { free_pack_available_at: new Date() },
        },
        sharedContext,
      );
    } else {
      await this.createCustomerAccountStates(
        [{ customer_id: customerId, free_pack_available_at: new Date() }],
        sharedContext,
      );
    }
  }

  /**
   * ATOMIC ONE-SHOT CLAIM of the free welcome pack — answers `true` to exactly
   * one caller, and `false` to every other.
   *
   * ONE conditional UPDATE, for the same reason as
   * claimGlobePayWithdrawalStatus: Postgres re-evaluates the predicate against
   * committed state AFTER the row lock is released, so of two concurrent
   * claims — a double-tapped "Open free pack" is the realistic trigger —
   * exactly one matches a row. A read-then-write (list the state, check
   * free_pack_claimed_at, then update) type-checks and reads like the same
   * guard, but takes no row lock: both callers see NULL and both open a free
   * pack. `true` means THIS caller owns the free open that follows.
   *
   * No row is lazily created here: an unstamped account has no
   * free_pack_available_at, so the WHERE matches nothing and the claim is
   * refused. No advisory lock either — the row lock is the whole mutex.
   */
  @InjectTransactionManager()
  async claimFreePack(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<boolean> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const rows = await em.execute<{ id: string }[]>(
      'UPDATE customer_account_state ' +
        'SET free_pack_claimed_at = now(), updated_at = now() ' +
        'WHERE customer_id = ? AND free_pack_available_at IS NOT NULL ' +
        'AND free_pack_claimed_at IS NULL AND deleted_at IS NULL ' +
        'RETURNING id',
      [customerId],
    );
    return rows.length > 0;
  }

  // Compensation for a free open that failed after the claim was won: hand the
  // customer back the pack they never received. Unconditional by design — the
  // workflow step only ever compensates the claim IT just won, and re-checking
  // free_pack_claimed_at here would just be the same row read twice.
  @InjectTransactionManager()
  async clearFreePackClaim(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute(
      'UPDATE customer_account_state ' +
        'SET free_pack_claimed_at = NULL, updated_at = now() ' +
        'WHERE customer_id = ? AND deleted_at IS NULL',
      [customerId],
    );
  }

  // Has this customer ever opened a PAID pack? The free pull's sell/deliver
  // lock reads this (refusal copy: FREE_PULL_LOCKED_MESSAGE) — 'free' and
  // 'reward' pulls are not purchases, so only source='pack' unlocks. One
  // indexed read (IDX_pull_customer_id_rolled_at), mirroring isPhoneVerified.
  @InjectManager()
  async hasPaidOpen(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<boolean> {
    const pulls = await this.listPulls(
      { customer_id: customerId, source: 'pack' },
      { take: 1, select: ['id'] },
      sharedContext,
    );
    return pulls.length > 0;
  }

  // The live free welcome pack, or null when the operator has not published
  // one (the storefront badge and the free-open path both go quiet then). It is
  // an ordinary Pack in the reserved 'free_welcome' category — hidden from the
  // public catalog like 'reward_box'. Admin validation keeps at most one
  // ACTIVE; rank ASC + take 1 makes this read deterministic regardless.
  @InjectManager()
  async getActiveFreePack(@MedusaContext() sharedContext: Context = {}) {
    const [pack] = await this.listPacks(
      { category: FREE_WELCOME_CATEGORY, status: 'active' },
      { take: 1, order: { rank: 'ASC' } },
      sharedContext,
    );
    return pack ?? null;
  }

  // True if the customer's login is administratively disabled. One indexed read
  // on the auth path — mirrors isFrozen.
  @InjectManager()
  async isAccountDisabled(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<boolean> {
    const [state] = await this.listCustomerAccountStates(
      { customer_id: customerId, disabled: true },
      { take: 1 },
      sharedContext,
    );
    return Boolean(state);
  }

  // Upsert a customer's manual-cashout bank destination + audit row in ONE
  // transaction (POLYCARD-BACK §4.3). Own advisory key — the row lives in its
  // own table, so this must not serialize against the credit ledger, but the
  // list-then-create still needs a lock or two concurrent first-saves race the
  // unique customer_id to a 23505. The audit row records the bank NAME plus a
  // last4: the FULL account number is admin-auth-only and must never be copied
  // into the audit feed (GET /admin/customers/:id/audit reads that table).
  // Without the last4 a same-bank account redirect reads as a no-op edit.
  @InjectTransactionManager()
  async setPayoutDetails(
    input: {
      customerId: string;
      adminId: string;
      bankName: string;
      bankAccountNumber: string;
      accountHolderName: string | null;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    bank_name: string;
    bank_account_number: string;
    account_holder_name: string | null;
  }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `payout:${input.customerId}`,
    ]);
    const [existing] = await this.listPlayerPayoutDetails(
      { customer_id: input.customerId },
      { take: 1 },
      sharedContext,
    );
    const data = {
      bank_name: input.bankName,
      bank_account_number: input.bankAccountNumber,
      account_holder_name: input.accountHolderName,
    };
    if (existing) {
      await this.updatePlayerPayoutDetails(
        { selector: { id: existing.id }, data },
        sharedContext,
      );
    } else {
      await this.createPlayerPayoutDetails(
        [{ customer_id: input.customerId, ...data }],
        sharedContext,
      );
    }
    // Digits only (stored numbers may carry spaces/hyphens) and ONLY when there
    // are more than four of them — for a <=4-digit account the "last4" would be
    // the whole number, which is exactly what must not reach the audit feed.
    const last4 = (n: string | null | undefined): string | null => {
      const digits = (n ?? '').replace(/\D/g, '');
      return digits.length > 4 ? digits.slice(-4) : null;
    };
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'customer',
          entity_id: input.customerId,
          action: 'edit',
          before: {
            bank_name: existing?.bank_name ?? null,
            account_last4: last4(existing?.bank_account_number),
          },
          after: {
            bank_name: input.bankName,
            account_last4: last4(input.bankAccountNumber),
          },
          reason: 'payout details updated',
        },
      ],
      sharedContext,
    );
    return data;
  }

  // One customer's saved payout destinations, unlocked.
  //
  // Exists for ONE caller: globepay-withdrawal.ts's pre-row destination
  // precheck, which has no transaction of its own. The decision that matters
  // does not come through here — withdrawForCashout calls loadSavedBankAccounts
  // directly on its own locked transaction manager, so this method cannot be
  // swapped underneath it.
  //
  // (The saved-accounts GET route reads the same blob through the customer
  // module instead. Same row, same content; it is a display list with no
  // transaction to join, so there is nothing to gain by routing it here.)
  @InjectManager()
  async savedBankAccountsFor(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<SavedBankAccount[]> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    return await loadSavedBankAccounts(em, customerId);
  }

  // Every destination that has actually RECEIVED money, one row per
  // (customer, bank, account), carrying its earliest settlement.
  //
  // Read by scripts/backfill-payout-destinations.ts only. It exists because
  // plan 088 made a payout resolve its destination from the customer's saved
  // list: a customer who was paid to an account BEFORE that list existed has
  // proven they control it, and should not sit out a cooling-off window to be
  // paid there again. `settled` is the whole point of the filter — `pending`
  // has not landed and `failed` came back, so neither is evidence of control.
  //
  // MIN(created_at) rather than settled_at: settled_at is nullable on rows that
  // predate it, and created_at is never null. Both are in the past, which is all
  // the backfill needs — it stamps a savedAt that is already outside the window.
  @InjectManager()
  async listSettledPayoutDestinations(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<
    {
      customer_id: string;
      bank_code: string;
      account_number: string;
      account_holder_name: string;
      /** RAW driver value, deliberately widened: whether pg hands back a Date
       *  or a string is a driver/config detail, and the one caller only ever
       *  runs against production. Declaring `Date` would be an unverifiable
       *  claim that turns into a TypeError there; this forces the coercion. */
      first_settled_at: string | Date;
    }[]
  > {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    return await em.execute(
      'SELECT customer_id, bank_code, account_number, ' +
        '  MIN(account_holder_name) AS account_holder_name, ' +
        '  MIN(created_at) AS first_settled_at ' +
        'FROM globepay_withdrawal ' +
        "WHERE status = 'settled' AND deleted_at IS NULL " +
        'GROUP BY customer_id, bank_code, account_number ' +
        'ORDER BY customer_id, first_settled_at',
    );
  }

  // Serialized read-modify-write of `customer.metadata`, the shared JSONB blob
  // that holds avatar_url / avatar_file_id / equipped_frame_level /
  // bank_accounts / handle. Every writer of it spread-merges the WHOLE blob, so
  // an unlocked read-then-write loses data: an avatar upload landing between a
  // saved bank account's read and its write republishes the pre-save blob and
  // the account the customer just saved is silently gone (and vice versa). The
  // same window lets two concurrent saves both pass a "under the cap" check.
  //
  // Precedent: setPayoutDetails above, which takes `payout:<customer>` for
  // exactly this reason — "the list-then-create still needs a lock".
  //
  // Key namespace is `metadata:`, NOT `credit:`. The credit ledger's invariant
  // (at most one `credit:` advisory lock per transaction, ever — see
  // matureDueCommissions) is untouched by a different namespace, but nothing
  // here may be composed into a transaction that already holds a `credit:`
  // lock.
  //
  // The lock, the read and the write are all raw SQL on the SAME `em`, i.e. the
  // SAME pooled connection. This is load-bearing, not a style choice: driving
  // the customer I/O through the customer module instead would acquire a SECOND
  // connection while this transaction holds the first, and
  // utils/db-driver-options.ts caps the pool at 5 PER PROCESS (shared by all ~25
  // modules) with idle_in_transaction_session_timeout at 30s. Five concurrent
  // mutations would each hold one connection and wait for another — a pool
  // deadlock — and under lesser contention the 30s kill would drop this session
  // (releasing the advisory lock) while the module's write committed anyway on
  // its own connection. That is the lock silently failing under exactly the
  // contention it exists for. Keeping everything on one connection also makes
  // the write atomic with the lock: a rollback undoes it.
  //
  // Reaching into the core `customer` table is the price. It is bounded to one
  // column, and the alternative breaks a documented invariant.
  @InjectTransactionManager()
  async mutateCustomerMetadata(
    input: {
      customerId: string;
      /**
       * Applied to the metadata read INSIDE the lock — never to a blob the
       * caller read earlier, which is the whole point of this method. Called
       * EXACTLY ONCE per invocation, so a callback may capture out-of-band
       * values from the blob it is handed (the avatar route reads the replaced
       * file id that way). Returning `null` means "nothing changed": no write
       * is issued, so an idempotent no-op (deleting an already-gone bank
       * account) stays write-free. Throwing refuses the whole mutation and
       * rolls the transaction back — that is how a cap check gets enforced
       * against the locked read.
       */
      mutate: (
        metadata: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Record<string, unknown>> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `metadata:${input.customerId}`,
    ]);
    const rows = await em.execute<{ metadata: Record<string, unknown> | null }[]>(
      'SELECT metadata FROM customer WHERE id = ? AND deleted_at IS NULL',
      [input.customerId],
    );
    if (rows.length === 0) {
      // Same shape retrieveCustomer raised before this went through SQL, so the
      // routes' 404 behaviour is unchanged.
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Customer with id: ${input.customerId} was not found`,
      );
    }
    const current = rows[0].metadata ?? {};
    const next = input.mutate(current);
    if (next === null) return current;
    await em.execute(
      'UPDATE customer SET metadata = ?::jsonb, updated_at = now() WHERE id = ? AND deleted_at IS NULL',
      [JSON.stringify(next), input.customerId],
    );
    return next;
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
        insufficientCreditsMessage(-deltaCents, availableCents),
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
      // SUSPENDED (referral programme retired): this fan-out is UNREACHABLE for
      // any new customer. It is gated on a referral_relationship row, and
      // linkSponsor — the only writer of that table — was removed. Existing
      // edges (if any survive in production) still pay, which is deliberate:
      // silently dropping a commission a recruit already earned would be a
      // money change disguised as a cleanup.
      //
      // Kept rather than excised because settleOpen is the atomic
      // open-settlement seam (debit + fan-out under ONE advisory lock) and the
      // guard below costs one indexed lookup that returns nothing. Excising it
      // is a separate, reviewable change against the most load-bearing money
      // function in the module — do not fold it into a cleanup commit.
      const basisSen = -externalFundedCents;
      if (basisSen > 0) {
        const [rel] = await this.listReferralRelationships(
          { customer_id: input.customerId },
          { take: 1 },
        );
        if (rel?.sponsor_id) {
          const sponsorId = rel.sponsor_id;
          // Sponsor's effective level ranks on their MONOTONIC lifetime TURNOVER
          // (refund-immune; spec §6 — a refund never lowers VIP level or the
          // commission tier it sets), NOT the refund-reducible creditSummary
          // basis (which nets reversed opens to zero). The lifetime counter already
          // backs VIP display/grants; this aligns the commission tier with it. The
          // commission BASIS itself (basisSen above) stays external-funded — only
          // the sponsor's TIER lookup uses turnover.
          // lifetimeTurnoverSenFor is @InjectManager like creditSummary, so the
          // level read stays off the locked path. (F5)
          const sponsorLifetimeSen =
            await this.lifetimeTurnoverSenFor(sponsorId);
          // UNIT TRAP: lifetimeTurnoverSenFor returns integer SEN, but
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
          // vip_level unseeded (migrations-without-seed) → skip the commission
          // fan-out rather than aborting the recruit's PAID open: a reward-like
          // grant must never void a paid charge (mirrors settleVipStep's
          // best-effort design; levelForSpend throws on an empty ladder). With a
          // PARTIALLY-seeded ladder levelForSpend still returns a present rung so
          // directReferralPctForLevel resolves (no throw); a rung whose
          // direct_referral_pct is NULL/0 simply pays 0% — sponsor under-payment,
          // house-favorable — so this fully-empty guard is the only degradation.
          let pct = 0;
          let commissionSen = 0;
          if (ladderRows.length === 0) {
            // eslint-disable-next-line no-console
            console.warn(
              `settleOpen: vip_level ladder is empty — skipping commission for open '${input.sourceTransactionId}' (recruit '${input.customerId}', sponsor '${sponsorId}'). Seed vip_level.`,
            );
          } else {
            const levelLadder = ladderRows.map((r) => ({
              level: r.level,
              spend_threshold: Number(r.spend_threshold),
            }));
            const pctLadder = ladderRows.map((r) => ({
              level: r.level,
              direct_referral_pct: Number(r.direct_referral_pct),
            }));
            const sponsorLevel = levelForSpend(sponsorLifetimeMyr, levelLadder);
            pct = directReferralPctForLevel(sponsorLevel, pctLadder);
            commissionSen = directCommissionSen(basisSen, pct);
          }

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
              // A purged customer keeps their referral edges — severing them
              // would dangle a recruit's upline and silently rewrite
              // attribution — so the edge still resolves here long after the
              // account is gone. Paying it mints credits onto an account with
              // no owner and no login, every time a surviving recruit opens a
              // pack, forever. The preflight cannot cover this: at delete time
              // the commission row does not exist yet.
              //
              // Per BENEFICIARY, not per sponsor. Skipping the whole fan-out
              // when the direct sponsor is deleted would dock every live upline
              // an override they earned; checking only the sponsor would still
              // pay a deleted ancestor. Both are wrong; this is not.
              //
              // sharedContext threaded so the read joins THIS locked txn rather
              // than taking a second pool connection (see recordPullsWithLedger).
              // Deliberately NOT wrapped in try/catch: a swallowed read error
              // would pay the deleted account, so a failure here rolls the open
              // back — the same fail-closed direction as the reads above.
              //
              // `.has(beneficiary)`, never `.size > 0`: the two are equivalent
              // only while the entity_id filter constrains. If it ever stopped
              // (a generated-method change, a renamed key), a size test would
              // read ANY delete_account row as this beneficiary's and silently
              // halt every commission to every live upline forever, as soon as
              // one account anywhere had been deleted — the inverse failure,
              // and the worse one, because under-paying the living is invisible
              // where over-paying the dead is at least auditable.
              if (
                (await this.deletedCustomerIds([beneficiary], sharedContext))
                  .has(beneficiary)
              ) {
                return;
              }
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

  // Wraps createPulls with the paired SP ledger row, same transaction
  // (POLYCARD-BACK §5.3). ONE row per open_id regardless of pull count — a
  // batch open is one charge and one ledger event (the caller passes every
  // pull for the open in a single input.pulls array, so there is exactly one
  // recordLedgerEntry call per invocation — no per-pull loop, so the
  // same-transaction self-duplication hazard the epic's idempotency rule
  // warns about does not arise here). ref_id = open_id (already unique per
  // open, single or batch; also what credit_transaction.source_transaction_id
  // stores for pack_open rows, so the Wallet-tab join in Task 9 keys on that
  // column for this type instead of credit_transaction.id).
  //
  // vault_delta uses the LENIENT resolveFxRate (see Global Constraints) —
  // this method never blocks a paid, already-committed pull on an FX gap.
  // The rate is resolved by the CALLER (record-pull.ts / record-pulls-batch.ts,
  // matching buyback-pull.ts:135's precedent) and passed in as
  // input.ledger.fx — NOT resolved in here. resolveFxRate has no
  // sharedContext, so calling it inside this @InjectTransactionManager()
  // method would acquire a SECOND pool connection while this one is holding
  // the write transaction (which itself holds a FOR UPDATE lock on
  // ledger_sequence for the whole quarter's SP scope) — the exact shape of
  // this codebase's prior KnexTimeoutError "pool is probably full" incidents.
  // The 30s display-fx cache makes that rare, not safe.
  //
  // recorded_value_usd is ALREADY market_value x the card's multiplier
  // (roll-pack.ts's draw-time snapshot — proven by
  // recorded-pull-value.integration.spec.ts, 20 x 1.2 = 24 — and consumed the
  // same way everywhere else that reads it: leaderboardTop/PULLED_VALUE_USD_SQL
  // convert it to MYR with `x fx` ONLY, never a second multiplier). So the
  // third argument to displayMarketPrice here is fixed at 1 — passing the
  // card's live market_multiplier again would double-count it (market_value x
  // multiplier^2 x fx instead of x multiplier x fx). No card lookup is needed
  // for this reason alone; every other displayMarketPrice call site in this
  // codebase passes raw card.market_value, never a pre-multiplied snapshot.
  @InjectTransactionManager()
  async recordPullsWithLedger(
    input: {
      pulls: Parameters<PacksModuleService['createPulls']>[0];
      ledger: {
        customerId: string;
        openId: string;
        price: number;
        packId: string;
        channel: 'single' | 'batch';
        fx: number;
        /**
         * Draw-time USD value for THIS open's vault_delta, overriding the sum
         * over `pulls`. Exists for the free welcome open: its pull row carries
         * recorded_value_usd NULL on purpose (the boards must never see a free
         * pull), but the card really does enter the vault, and the later
         * sell/delivery subtracts its full value — so a NULL-derived 0 here
         * would drift cumulative vault liability down forever. Free opens are
         * always single-pull (batch rejects free_welcome), hence one scalar.
         */
        vaultValueUsd?: number | null;
      };
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Awaited<ReturnType<PacksModuleService['createPulls']>>> {
    const pulls = await this.createPulls(input.pulls, sharedContext);

    const vaultDelta =
      input.ledger.vaultValueUsd != null
        ? displayMarketPrice(input.ledger.vaultValueUsd, input.ledger.fx, 1)
        : input.pulls.reduce(
            (sum, p) =>
              sum +
              displayMarketPrice(
                Number(p.recorded_value_usd),
                input.ledger.fx,
                1,
              ),
            0,
          );

    await this.recordLedgerEntry(
      {
        type: 'SP',
        customerId: input.ledger.customerId,
        refId: input.ledger.openId,
        walletDelta: -input.ledger.price,
        vaultDelta: Math.round(vaultDelta * 100) / 100,
        payload: {
          type: 'SP',
          channel: input.ledger.channel,
          pack_id: input.ledger.packId,
          // String(...) rather than a bare p.card_id: the generated
          // createPulls parameter type resolves card_id as string |
          // undefined here (Parameters<> picks it up loosely), even though
          // every real caller (record-pull.ts / record-pulls-batch.ts)
          // always supplies a concrete Card.handle string.
          prize_skus: input.pulls.map((p) => String(p.card_id)),
        },
      },
      sharedContext,
    );
    return pulls;
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
  // ANY-cause freeze read (manual OR auto) — the gate settleOpen holds over
  // every paid open. Public because the FREE open never reaches settleOpen
  // (a price-0 charge returns early), so claim-free-pack.ts has to run the
  // same check itself; assertNotFrozen is NOT the same gate (manual only).
  async isFrozen(
    customerId: string,
    sharedContext: Context = {},
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

  // The raw signed ledger balance, in INTEGER CENTS.
  //
  // Two deliberate divergences from this file's conventions, both required by
  // the account-deletion gate that is its only caller:
  //
  //  - Cents, not the MYR decimals every sibling returns. The gate tests for
  //    exact zero, and a float RM comparison is the wrong instrument for that.
  //  - Freeze-blind and lock-blind. availableBalance() returns 0 for a frozen
  //    account and subtracts lockedCommissionCents, so a frozen account still
  //    holding funds — or one whose balance happens to equal its locked
  //    commission — reads as 0 there. Deleting either would strand real money.
  //
  // Signed, so a clawback-negative account (which owes us) is also non-zero and
  // is therefore refused by the same `!== 0` test.
  @InjectManager()
  async rawLedgerBalanceCents(
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
    return Number(rows[0]?.balance_cents ?? 0);
  }

  // Everything that must be settled before an account may be deleted.
  //
  // A PLAIN READ, holding no lock and running in no transaction — it is
  // @InjectManager, and the delete route calls it bare. Its job is the fast,
  // friendly rejection that hands the customer one actionable reason. The
  // authoritative check is this same method re-run INSIDE
  // purgeAccountPacksData's advisory lock; do not read this comment as a
  // guarantee that the two are one atomic step, because they are not.
  //
  // Order is cheapest-first, and each check returns immediately: the customer
  // gets ONE actionable instruction rather than a list, and a blocked delete
  // costs one query in the common case.
  @InjectManager()
  async deleteAccountPreflight(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<
    { ok: true } | { ok: false; reason: DeleteBlockReason; detail: string }
  > {
    // FIRST, because it is the cheapest check and the most absolute: a freeze is
    // an active hold, and deletion would destroy the very evidence it preserves
    // (the purge HARD-deletes player_payout_details — bank name, full account
    // number, holder name — and blanks globepay_withdrawal.account_holder_name).
    //
    // None of the checks below catch it. `frozen` is ORTHOGONAL to `disabled`,
    // so no store-side guard rejects a frozen session, and rawLedgerBalanceCents
    // is deliberately freeze-blind — a frozen account whose raw balance happens
    // to be exactly 0 cleared every other gate here.
    if (await this.isFrozen(customerId, sharedContext)) {
      return {
        ok: false,
        reason: 'ACCOUNT_FROZEN',
        detail: 'This account is under review.',
      };
    }

    const balanceCents = await this.rawLedgerBalanceCents(
      customerId,
      sharedContext,
    );
    if (balanceCents !== 0) {
      return {
        ok: false,
        reason: 'BALANCE_NOT_ZERO',
        // Negative means the account owes us (a clawback). Both directions are
        // refused; the copy just has to be honest about which one it is.
        detail:
          balanceCents > 0
            ? `Wallet balance is RM ${(balanceCents / 100).toFixed(2)}.`
            : `Account owes RM ${(Math.abs(balanceCents) / 100).toFixed(2)}.`,
      };
    }

    const [withdrawal] = await this.listGlobePayWithdrawals(
      { customer_id: customerId, status: ['pending', 'held'] },
      { take: 1 },
      sharedContext,
    );
    if (withdrawal) {
      return {
        ok: false,
        reason: 'WITHDRAWAL_PENDING',
        detail: 'A withdrawal is still being processed.',
      };
    }

    // Production credits deposits through the reconcile sweep, not the callback,
    // so an in-flight deposit can land hours later and credit an account that
    // no longer has an owner.
    //
    // 'expired' is in this list because it is NOT terminal: the sweep selects
    // expired rows and flips them to 'settled', crediting the customer. The
    // failure it prevents is concrete — the transfer doesn't land, the row
    // expires, the customer deletes at balance 0, the transfer arrives, and
    // the sweep credits an ownerless account.
    const [deposit] = await this.listGlobePayDeposits(
      { customer_id: customerId, status: ['pending', 'expired'] },
      { take: 1 },
      sharedContext,
    );
    if (deposit) {
      return {
        ok: false,
        reason: 'DEPOSIT_PENDING',
        detail: 'A deposit is still being processed.',
      };
    }

    // A vaulted pull is an owned asset the customer can still sell for credits;
    // a delivering one is already on its way out. Either is unsettled value.
    const [pull] = await this.listPulls(
      { customer_id: customerId, status: ['vaulted', 'delivering'] },
      { take: 1 },
      sharedContext,
    );
    if (pull) {
      return {
        ok: false,
        reason: 'CARDS_UNSETTLED',
        detail: 'You still have cards in your vault.',
      };
    }

    // Nothing may still be shipping to an address this purge is about to erase.
    //
    // Expressed as "not terminal" rather than as the list of in-flight
    // statuses: the enumeration is an exact complement TODAY, so a status
    // added later would silently pass the guard — a delete that fails open.
    // The terminal set is the half that does not grow.
    const [delivery] = await this.listDeliveryOrders(
      {
        customer_id: customerId,
        status: { $nin: ['completed', 'canceled'] },
      },
      { take: 1 },
      sharedContext,
    );
    if (delivery) {
      return {
        ok: false,
        reason: 'DELIVERY_IN_FLIGHT',
        detail: 'A delivery is still on its way.',
      };
    }

    return { ok: true };
  }

  // Which of these customers no longer have an owner.
  //
  // The `delete_account` audit row is the signal, rather than the account-state
  // tombstone or the customer row's deleted_at: it is written inside the same
  // packs transaction as the rest of the purge, it is purpose-built for this
  // (an admin cannot produce one by typing a disable reason), and it is written
  // BEFORE the customer soft delete, so it covers a half-finished purge too.
  // The customer module is not reachable from this service anyway.
  //
  // The two callers use this very differently, and a comment that flatters
  // either one would mislead the next reader: settleChallengeWeek reads the
  // WHOLE ranking in one query (at most ten ids, outside the per-winner
  // transactions, service.ts:7619), while payCommission calls it once per
  // BENEFICIARY inside its fan-out loop (service.ts:3427) — inside the credit
  // advisory lock — so one pack open runs it about five times. Hoisting a
  // batched read out of that loop would mean restructuring it for ~5 index
  // seeks, which is not worth doing; it is worth not claiming otherwise.
  //
  // No `take`. The id count looked safe because the audit write is idempotent,
  // but "near-impossible" is not "impossible": a second delete_account row for
  // one customer would push another customer's row past the limit and hand back
  // a set that silently omits a deleted account — which then gets PAID. The
  // filter already constrains the read to these ids; a bound on top of it buys
  // nothing and can only subtract.
  //
  // entity_type is redundant for correctness (only the purge writes
  // 'delete_account', always with 'customer') but NOT for cost: the sole usable
  // index is IDX_admin_action_audit_entity on (entity_type, entity_id), and
  // omitting the leading column drops the seek for a full scan. admin_action_
  // audit is append-only and grows with every admin money mutation forever,
  // and payCommission runs this read inside settleOpen's credit advisory lock.
  @InjectManager()
  async deletedCustomerIds(
    customerIds: string[],
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Set<string>> {
    if (customerIds.length === 0) return new Set();
    const rows = await this.listAdminActionAudits(
      {
        entity_type: 'customer',
        entity_id: customerIds,
        action: 'delete_account',
      },
      {},
      sharedContext,
    );
    return new Set(rows.map((r) => r.entity_id));
  }

  // The packs-module half of an account deletion: scrub the personal data out
  // of the rows we KEEP, and delete the rows that are pure personal data.
  //
  // Transactional within this module. The rest of the purge (customer row,
  // notifications, auth identities, avatar object) lives in other modules and
  // cannot join this transaction — see the route for the ordering that makes a
  // partial failure recoverable.
  //
  // What is deliberately NOT touched: credit_transaction, ledger_entry,
  // globepay_deposit, pull, commission, vip_member_state and
  // referral_relationship. Those are the business books. They carry only a
  // customer_id that no longer resolves to a person, and the referral rows in
  // particular must survive or a downline's upline dangles.
  @InjectTransactionManager()
  async purgeAccountPacksData(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);
    // Re-check INSIDE the lock. The route's earlier preflight is the fast,
    // friendly rejection that gives the customer an actionable reason; THIS one
    // is the correctness gate. Without it a spin, sell, deposit credit or
    // withdrawal landing between the two calls would be purged straight
    // through — and that window is minutes wide in production, because
    // deposits are credited by the reconcile sweep rather than the callback.
    const check = await this.deleteAccountPreflight(customerId, sharedContext);
    if (!check.ok) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, check.reason);
    }

    // Retained financial rows, scrubbed to the operator-chosen minimum: the
    // amounts, statuses, gateway ids and timestamps that make the books
    // reconcile stay; the counterparty identity goes. Last 4 of the account
    // number is kept for the same reason setPayoutDetails keeps it in its audit
    // row — a same-bank redirect is otherwise indistinguishable from a no-op.
    await em.execute(
      `update "globepay_withdrawal"
          set "account_number" = right("account_number", 4),
              "account_holder_name" = ''
        where "customer_id" = ?`,
      [customerId],
    );
    // proof_images goes with the address fields, not with the tracking number:
    // a doorstep photo can show the label or the recipient, which re-exposes
    // exactly what the ship_* scrub removes. NOTE the column holds admin-typed
    // http(s) URLs, not file-provider ids (admin/delivery-orders/validate.ts:126),
    // so nulling it removes our copy of the reference — an object hosted in our
    // own bucket still needs an operator sweep, and there is no id to hand the
    // file workflow.
    //
    // ship_country_code is NOT NULL and deliberately left alone: a bare country
    // is not identifying, and it is what makes a shipped order's cost still
    // reconcile.
    await em.execute(
      `update "delivery_order"
          set "ship_name" = '', "ship_address_1" = '', "ship_address_2" = null,
              "ship_city" = '', "ship_province" = null, "ship_postal_code" = '',
              "ship_phone" = null, "proof_images" = null
        where "customer_id" = ?`,
      [customerId],
    );

    // Pure personal data, no business value — deleted outright.
    await em.execute(
      `delete from "player_payout_details" where "customer_id" = ?`,
      [customerId],
    );
    await em.execute(`delete from "notification_read" where "customer_id" = ?`, [
      customerId,
    ]);

    // The account-state row is the TOMBSTONE, not garbage. Soft-deleting it is
    // what would re-open the account: isAccountDisabled reads through
    // listCustomerAccountStates, which excludes soft-deleted rows, so it would
    // return false and the session guard would wave requests through — and a
    // bearer minted before the delete keeps verifying for up to a day (JWT auth
    // does no DB lookup and medusa-config.ts sets no jwtExpiresIn, so the
    // framework default "1d" applies).
    //
    // Upsert, not a bare UPDATE: most customers have never been disabled or
    // frozen and therefore have NO row at all (setAccountDisabled creates it
    // lazily), and an update that no-ops for them would leave the commonest
    // account with no tombstone at all.
    //
    // CONSEQUENCE, deliberate: from this write on, the blanket /store/* session
    // guard 403s this customer's own bearer, so the customer cannot re-drive the
    // route after a later step fails. Finishing a half-done purge is a manual
    // job; see the route header for exactly how narrow that is.
    const tombstone = {
      disabled: true,
      disabled_reason: 'Account deleted by the customer.',
      disabled_at: new Date(),
    };
    const [state] = await this.listCustomerAccountStates(
      { customer_id: customerId },
      { take: 1 },
      sharedContext,
    );
    if (state) {
      await this.updateCustomerAccountStates(
        { selector: { id: state.id }, data: tombstone },
        sharedContext,
      );
    } else {
      await this.createCustomerAccountStates(
        [{ customer_id: customerId, ...tombstone }],
        sharedContext,
      );
    }

    // Idempotent: a half-finished purge gets finished by hand, and an audit
    // trail that grows a row per attempt reports one deletion as several.
    const [existingAudit] = await this.listAdminActionAudits(
      { entity_id: customerId, action: 'delete_account' },
      { take: 1 },
      sharedContext,
    );
    if (!existingAudit) {
      await this.createAdminActionAudits(
        [
          {
            admin_id: customerId,
            entity_type: 'customer',
            entity_id: customerId,
            action: 'delete_account',
            before: { deleted: false },
            after: { deleted: true },
            reason: 'Customer deleted their own account.',
          },
        ],
        sharedContext,
      );
    }
  }

  // Wallet summary: raw balance, available (freeze-aware), locked (pending-
  // unmatured + suspended commissions), the earliest pending maturity
  // tranche (date + amount), and the playthrough withdrawal gate
  // (withdrawable.ts): deposits must be fully spent on pack opens before any
  // balance may leave. All amounts in MYR (RM) — the ledger is already
  // stored in MYR decimals, never USD.
  // available = isFrozen ? 0 : balance − locked  (matches availableBalance).
  // withdrawable = gate open ? available : 0.
  @InjectManager()
  async walletSummary(
    customerId: string,
    // Optional pre-computed inputs from a caller that already scanned this
    // customer's ledger (credits/route.ts threads creditSummary's scalars) so
    // the balance/deposited/used scan runs once per request instead of twice.
    // Units: balance in MYR, depositedCents/usedCents in integer cents — the
    // same units this method's own scan produces. Omitted → self-scan (direct
    // callers and module specs are unchanged). lockedCommission/nextUnlock/
    // isFrozen always query regardless (they're not in creditSummary).
    precomputed?: {
      balance: number;
      depositedCents: number;
      usedCents: number;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    balance: number;
    available: number;
    locked: number;
    isFrozen: boolean;
    nextUnlock: { amount: number; date: string } | null;
    withdrawable: number;
    playthrough: { deposited: number; used: number; remaining: number };
  }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;

    // Raw balance = Σ(amount) over the append-only ledger, summed in integer
    // cents to avoid float drift (matches availableBalance pattern, spec §8).
    // Same scan also folds the playthrough inputs: deposited = Σ positive
    // topup rows; used = Σ −external_funded_cents over pack_open rows —
    // deposit-funded spend only; commission/buyback/adjustment-funded opens
    // contribute 0, and a reversed open restores its basis via the mirror
    // row's −originalExt. Buyback / promo / commission rows touch neither sum.
    // Pre-1b topup rows (external_funded_cents IS NULL) are grandfathered out of
    // deposited: they predate the basis column, so their opens' spend is equally
    // invisible to used — counting them would lock those deposits forever.
    let balance: number;
    let depositedCents: number;
    let usedCents: number;
    if (precomputed) {
      balance = precomputed.balance;
      depositedCents = precomputed.depositedCents;
      usedCents = precomputed.usedCents;
    } else {
      const balRows = await em.execute<
        {
          balance_cents: string | null;
          deposited_cents: string | null;
          used_cents: string | null;
        }[]
      >(
        'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents, ' +
          `COALESCE(SUM(ROUND(amount * 100)) FILTER (WHERE ${DEPOSITED_PT_FILTER}), 0)::bigint AS deposited_cents, ` +
          "COALESCE(SUM(-external_funded_cents) FILTER (WHERE reason = 'pack_open'), 0)::bigint AS used_cents " +
          'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
        [customerId],
      );
      balance = Number(balRows[0]?.balance_cents ?? 0) / 100;
      depositedCents = Number(balRows[0]?.deposited_cents ?? 0);
      usedCents = Number(balRows[0]?.used_cents ?? 0);
    }

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
    // ONE division, from the integer-cent values, instead of subtracting two
    // already-divided floats. `balanceCents/100 - lockedCents/100` can land a
    // hair under the exact figure (6407/100 - 1407/100 === 49.99999999999999),
    // and because withdrawalGateError compares `amount <= withdrawable` while
    // the UI renders the same number with toFixed(2), the customer is shown
    // "RM 50.00" and refused when they type 50. At the RM 50 minimum that
    // leaves nothing they can withdraw at all until the arithmetic shifts.
    const available = frozen
      ? 0
      : (Math.round(balance * 100) - Math.round(locked * 100)) / 100;

    // Playthrough gate: all-or-nothing on the available balance. Spending on
    // packs stays unrestricted either way — the gate only limits cashout.
    const gate = playthroughState({ depositedCents, usedCents });
    const withdrawable = gate.withdrawable ? Math.max(0, available) : 0;

    return {
      balance,
      available,
      locked,
      isFrozen: frozen,
      nextUnlock,
      withdrawable,
      playthrough: {
        deposited: depositedCents / 100,
        used: usedCents / 100,
        remaining: gate.remainingCents / 100,
      },
    };
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
  // volume ("winnings") = Σ won-card VALUE in MYR — the pull's RECORDED
  // draw-time USD value (recorded_value_usd, stamped by the open workflows so a
  // mid-week price sync can't rewrite history), falling back to live
  // market_value(USD) × the card's multiplier for pre-backfill rows — × the
  // live FX rate. Only source='pack' pulls count: reward-box prizes and free
  // welcome pulls are not played packs (positive filter, so a future fourth
  // source can never leak onto the board by default).
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
        '         SUM(' +
        PULLED_VALUE_USD_SQL +
        ') AS volume_usd ' +
        '    FROM pull pu ' +
        '    LEFT JOIN card c ON c.handle = pu.card_id AND c.deleted_at IS NULL ' +
        "   WHERE pu.deleted_at IS NULL AND pu.customer_id IS NOT NULL AND pu.source = 'pack' " +
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

  // Public-profile stats aggregated in the DB (plan 022) — replaces the
  // route's 20k-row JS fold. Same execution shape as leaderboardTop, scoped
  // to one customer. Semantics pinned to the old in-route fold:
  //  - only source='pack' pulls (C1: reward pulls are private vault items),
  //  - capped to the NEWEST 20k pulls (the route's documented MAX_PULLS
  //    aggregation cap — now the LIMIT in the `capped` CTE),
  //  - volume = Σ per-card MYR display value with PER-CARD rounding, exactly
  //    displayMarketPrice(fmv, fx, multiplier): ROUND(fmv × mult × fx, 2) —
  //    deliberately LIVE-priced (vault/display semantics), NOT the
  //    recorded_value_usd snapshot the leaderboard/challenge boards read, so
  //    profile volume tracks current prices and may diverge from board volume,
  //    degenerate inputs (fmv < 0 or multiplier ≤ 0) → 0, missing/deleted
  //    card → 0 (the pull still counts). Per-card rounding keeps the
  //    documented cents-level drift vs the leaderboard's sum-level round.
  //  - by_rarity = COUNT per rarity resolved from the LIVE (pack_id, card_id)
  //    odds row, defaulting to 'Common' when none matches or rarity is NULL —
  //    mirrors makeRarityOf's `?? 'Common'` fallback (card-view.ts).
  // The customer scan rides IDX_pull_customer_id_rolled_at.
  @InjectManager()
  async profileStatsForCustomer(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    pulls: number;
    volume: number;
    by_rarity: Record<string, number>;
  }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    // FX is a JS-side input (same seam as leaderboardTop) so profile volume
    // and the board convert USD→MYR through the identical resolved rate.
    const fxRate = await resolveFxRate(this);

    const rows = await em.execute<
      { rarity: string; pulls: string; volume_myr: string | null }[]
    >(
      `WITH capped AS (
         SELECT pack_id, card_id
           FROM pull
          WHERE customer_id = ? AND source = 'pack' AND deleted_at IS NULL
          ORDER BY rolled_at DESC
          LIMIT 20000 -- MAX_PULLS: the route's documented aggregation cap
       ), odds AS (
         -- one rarity per (pack, card): the old JS Map dedupe made duplicate
         -- odds rows harmless; DISTINCT ON keeps this join from fanning out
         -- the per-pull counts. id DESC ≈ the Map's last-row-wins.
         SELECT DISTINCT ON (pack_id, card_id) pack_id, card_id, rarity
           FROM pack_odds
          WHERE deleted_at IS NULL AND card_id IS NOT NULL
          ORDER BY pack_id, card_id, id DESC
       )
       SELECT COALESCE(o.rarity, 'Common') AS rarity,
              COUNT(*)::bigint AS pulls,
              COALESCE(SUM(
                CASE
                  WHEN c.handle IS NULL THEN 0
                  WHEN COALESCE(c.market_value, 0) < 0
                    OR COALESCE(c.market_multiplier, ?) <= 0 THEN 0
                  ELSE ROUND(
                         COALESCE(c.market_value, 0)
                         * COALESCE(c.market_multiplier, ?)
                         * ? * 100
                       ) / 100
                END
              ), 0) AS volume_myr
         FROM capped p
         LEFT JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL
         LEFT JOIN odds o ON o.pack_id = p.pack_id AND o.card_id = p.card_id
        GROUP BY 1`,
      [
        customerId,
        DEFAULT_MARKET_MULTIPLIER,
        DEFAULT_MARKET_MULTIPLIER,
        fxRate,
      ],
    );

    let pulls = 0;
    let volume = 0;
    const by_rarity: Record<string, number> = {};
    for (const r of rows) {
      const n = Number(r.pulls ?? 0);
      pulls += n;
      volume += Number(r.volume_myr ?? 0);
      by_rarity[r.rarity] = (by_rarity[r.rarity] ?? 0) + n;
    }
    return { pulls, volume, by_rarity };
  }

  // Per-reason lifetime ledger sums for /admin/economy — one GROUP BY instead
  // of paging the whole ledger to Node (audit 2026-07-07 #5b). Emitted as
  // synthetic {reason, amount} rows so economy.ts's unit-tested ledgerTotals
  // fold (incl. its unknown-reason loud throw) keeps shaping the report.
  // Optional half-open [from, to) ISO window scopes the totals to a period
  // (Daily/Weekly/…); both omitted = all time (the original behavior). Served
  // by the indexed created_at column.
  @InjectManager()
  async ledgerReasonTotals(
    from?: string,
    to?: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Array<{ reason: string; amount: number }>> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const params: unknown[] = [];
    let sql =
      'SELECT reason, COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS cents ' +
      'FROM credit_transaction WHERE deleted_at IS NULL';
    if (from) {
      sql += ' AND created_at >= ?::timestamptz';
      params.push(from);
    }
    if (to) {
      sql += ' AND created_at < ?::timestamptz';
      params.push(to);
    }
    sql += ' GROUP BY reason';
    const rows = await em.execute<{ reason: string; cents: string }[]>(
      sql,
      params,
    );
    return rows.map((r) => ({
      reason: r.reason,
      amount: Number(r.cents) / 100,
    }));
  }

  // Vault liability = Σ over vaulted pulls of ROUND(card DISPLAY value × fx ×
  // 100) sen, computed in the DB. Display value (FMV × market_multiplier, via
  // the shared LIVE_VALUE_USD_SQL) is the basis buyback percents credit
  // against, so this is the obligation the operator actually owes if every
  // vaulted card were sold — raw FMV understated it by the markup (issue #263).
  // profileStatsForCustomer and the economy report's EV/RTP already used this
  // basis; the admin aggregates were the last raw-FMV holdouts.
  //
  // There is NO source filter: a vaulted pull is an obligation whoever won it,
  // so reward pulls count too — as they should, since the operator owes those
  // cards as much as pulled ones. What the INNER JOIN drops is a pull whose
  // card reference is orphaned or soft-deleted (a reward-box prize points at a
  // PRODUCT handle, not a card, so it falls out here for that reason, not
  // because of its source). `playersOverview`'s twin behaves identically.
  @InjectManager()
  async vaultLiabilityMyr(
    fx: number,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ count: number; liability: number }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const rows = await em.execute<{ n: string; cents: string }[]>(
      'SELECT COUNT(*)::bigint AS n, ' +
        `       COALESCE(SUM(ROUND(${LIVE_VALUE_USD_SQL} * ? * 100)), 0)::bigint AS cents ` +
        '  FROM pull p ' +
        '  JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL ' +
        " WHERE p.status = 'vaulted' AND p.deleted_at IS NULL",
      [DEFAULT_MARKET_MULTIPLIER, fx],
    );
    return {
      count: Number(rows[0]?.n ?? 0),
      liability: Number(rows[0]?.cents ?? 0) / 100,
    };
  }

  // linkSponsor was REMOVED (referral programme retired).
  //
  // It was the only writer of referral_relationship, and its cycle probe was a
  // recursive CTE with UNION ALL, no depth bound and no dedup: against a cyclic
  // graph where the sought id is not on the walk it never terminated, pinning a
  // pooled connection until the pool was exhausted. Postgres does not detect
  // cycles without an explicit CYCLE clause, and statement_timeout cannot be set
  // through databaseDriverOptions (see utils/db-driver-options.ts).
  //
  // The commission fan-out in settleOpen is now unreachable for any new
  // customer: it is guarded by a referral_relationship lookup, and with no
  // writer left no new edge can exist. It is deliberately left in place rather
  // than excised, because settleOpen is the atomic open-settlement seam and its
  // invariants are load-bearing — see the SUSPENDED note at that guard.

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

  // Batched per-player aggregates for the admin Players list (POLYCARD-BACK
  // §4.2): ONE query per aggregate per page, never per-row. The credit SQL is
  // the GROUP BY twin of creditSummary (service.ts:661) and the vault SQL the
  // customer-scoped twin of vaultLiabilityMyr — same display-value convention
  // (FMV × market_multiplier, issue #263), same 'vaulted' predicate, no source
  // filter, and the same INNER JOIN, so a vaulted pull whose card was soft-deleted drops out
  // of BOTH vault_count and vault_value (profileStatsForCustomer deliberately
  // differs — its LEFT JOIN still counts the pull at 0). Keeping the twin exact
  // is what makes the Players list and the economy dashboard agree.
  @InjectManager()
  async playersOverview(
    ids: string[],
    fx: number,
    @MedusaContext() sharedContext: Context = {},
  ) {
    const wallet = new Map<
      string,
      {
        balanceCents: number;
        // VIP-basis net pack_open spend — the same expression creditSummary
        // calls vip_spend_cents (NOT its differently-defined spend_cents).
        vipSpendCents: number;
        lastSpendAt: string | null;
      }
    >();
    const vault = new Map<string, { count: number; cents: number }>();
    const pullCount = new Map<string, number>();
    const vipLevel = new Map<string, number>();
    // phoneVerified rides along on a query that already reads this row: with
    // the topup/delivery gate live, "why can't this player top up?" is the
    // question the Players list has to be able to answer.
    const state = new Map<
      string,
      { frozen: boolean; disabled: boolean; phoneVerified: boolean }
    >();
    if (ids.length === 0) return { wallet, vault, pullCount, vipLevel, state };

    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const ph = ids.map(() => '?').join(',');
    // Sequential to avoid concurrent queries on the shared injected EntityManager.
    const credits = await em.execute<
      {
        customer_id: string;
        balance_cents: string;
        vip_spend_cents: string;
        last_spend_at: string | null;
      }[]
    >(
      'SELECT customer_id, ' +
        '  COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents, ' +
        "  COALESCE(SUM(CASE WHEN reason = 'pack_open' THEN ROUND(-amount * 100) ELSE 0 END), 0)::bigint AS vip_spend_cents, " +
        "  MAX(created_at) FILTER (WHERE reason = 'pack_open') AS last_spend_at " +
        `FROM credit_transaction WHERE customer_id IN (${ph}) AND deleted_at IS NULL GROUP BY customer_id`,
      ids,
    );
    const vaults = await em.execute<
      { customer_id: string; n: string; cents: string }[]
    >(
      'SELECT p.customer_id, COUNT(*)::bigint AS n, ' +
        `  COALESCE(SUM(ROUND(${LIVE_VALUE_USD_SQL} * ? * 100)), 0)::bigint AS cents ` +
        '  FROM pull p JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL ' +
        ` WHERE p.status = 'vaulted' AND p.deleted_at IS NULL AND p.customer_id IN (${ph}) GROUP BY p.customer_id`,
      [DEFAULT_MARKET_MULTIPLIER, fx, ...ids],
    );
    const pulls = await em.execute<{ customer_id: string; n: string }[]>(
      `SELECT customer_id, COUNT(*)::bigint AS n FROM pull WHERE source = 'pack' AND deleted_at IS NULL AND customer_id IN (${ph}) GROUP BY customer_id`,
      ids,
    );
    const vips = await em.execute<
      { customer_id: string; current_level: number }[]
    >(
      `SELECT customer_id, current_level FROM vip_member_state WHERE customer_id IN (${ph}) AND deleted_at IS NULL`,
      ids,
    );
    const states = await em.execute<
      {
        customer_id: string;
        frozen: boolean;
        disabled: boolean;
        phone_verified_at: string | null;
      }[]
    >(
      `SELECT customer_id, frozen, disabled, phone_verified_at FROM customer_account_state WHERE customer_id IN (${ph}) AND deleted_at IS NULL`,
      ids,
    );

    for (const r of credits)
      wallet.set(r.customer_id, {
        balanceCents: Number(r.balance_cents),
        vipSpendCents: Number(r.vip_spend_cents),
        lastSpendAt: r.last_spend_at,
      });
    for (const r of vaults)
      vault.set(r.customer_id, { count: Number(r.n), cents: Number(r.cents) });
    for (const r of pulls) pullCount.set(r.customer_id, Number(r.n));
    for (const r of vips) vipLevel.set(r.customer_id, Number(r.current_level));
    for (const r of states)
      state.set(r.customer_id, {
        frozen: Boolean(r.frozen),
        disabled: Boolean(r.disabled),
        phoneVerified: r.phone_verified_at !== null,
      });
    return { wallet, vault, pullCount, vipLevel, state };
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

  // Close the instant-buyback window for the caller's OWN pulls — called when
  // the reveal ends or the customer leaves it, so the vault (and every later
  // sell) quotes the flat rate even inside the 30s. CLOSE-ONLY and idempotent:
  // the filtered update stamps only where instant_closed_at IS NULL, so it can
  // end the premium early but never re-open it, and a foreign/already-closed id
  // is a silent no-op (no existence leak). The 30s time deadline stays the
  // backstop for a hard tab-kill that never calls this.
  async closeInstantWindow(
    pullIds: string[],
    customerId: string,
    nowMs: number = Date.now(),
  ): Promise<{ closed: number }> {
    // Dedupe + bound defensively (the route already does, but a direct caller
    // must not be able to drive an oversized IN(...) either).
    const ids = [
      ...new Set(
        (pullIds ?? []).filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        ),
      ),
    ].slice(0, 50);
    if (ids.length === 0) return { closed: 0 };
    const open = await this.listPulls(
      { id: ids, customer_id: customerId, instant_closed_at: null },
      { take: ids.length },
    );
    if (open.length === 0) return { closed: 0 };
    await this.updatePulls({
      selector: { id: open.map((p) => p.id), instant_closed_at: null },
      data: { instant_closed_at: new Date(nowMs) },
    });
    return { closed: open.length };
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

  // Atomic, serialized delivery-order status transition — THE seam every order
  // status move must use (admin advance/ship/deliver, customer cancel). Holds a
  // per-order xact-scoped advisory lock across a FRESH status re-read, the
  // transition validation, the order-row write, and the covered pulls' guarded
  // flip — all in ONE transaction. Two concurrent cancels therefore serialize:
  // the winner cancels and re-vaults the pulls; the loser re-reads 'canceled'
  // under the lock and refuses with a clean NOT_ALLOWED, writing nothing
  // (2026-07 day-3 sim: without this, the loser's manual revert landed AFTER
  // the winner's terminal write, stranding the order at 'requested' with its
  // pulls already re-vaulted — one physical card deliverable into a SECOND
  // live order). Rollback is transactional, so no undo path can ever revert
  // the order row after a terminal write.
  @InjectTransactionManager()
  async transitionDeliveryOrderStatus(
    input: {
      orderId: string;
      to: DeliveryStatus;
      /** Resolved tracking number to persist (incoming or already-stored). */
      trackingNumber: string | null;
      /** Replaces the proof-photo set wholesale when provided. */
      proofImages?: string[];
      /** Every pull the order covers — flipped on completed/canceled. */
      pullIds: string[];
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ status: DeliveryStatus }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `delivery:${input.orderId}`,
    ]);

    const [order] = await this.listDeliveryOrders(
      { id: input.orderId },
      { take: 1 },
      sharedContext,
    );
    if (!order) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Delivery order '${input.orderId}' not found.`,
      );
    }

    // Validate against the under-lock read — the ONLY status that matters.
    const verdict = validateDeliveryStatusTransition(
      order.status,
      input.to,
      !!input.trackingNumber,
    );
    if (verdict === 'invalid_transition') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Cannot move a ${order.status} order to ${input.to}.`,
      );
    }
    if (verdict === 'tracking_required') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'A tracking number is required to mark an order shipped.',
      );
    }

    // proof_images (json column) replaces wholesale — Medusa assign merges
    // POJOs but replaces arrays, so [] cleanly clears every photo.
    const patch: Record<string, unknown> = {
      id: input.orderId,
      status: input.to,
      tracking_number: input.trackingNumber,
    };
    if (input.proofImages !== undefined) patch.proof_images = input.proofImages;
    if (input.to === 'shipped') patch.shipped_at = new Date();
    // delivered_at doubles as completed_at post-rename.
    if (input.to === 'completed') patch.delivered_at = new Date();
    await this.updateDeliveryOrders([patch], sharedContext);

    // Pull side-effects ride the SAME transaction: completed → delivered
    // (PULL enum, terminal); canceled → back to the vault. The guarded flip
    // (WHERE status='delivering') throwing rolls back the order write with it.
    if (
      input.pullIds.length &&
      (input.to === 'completed' || input.to === 'canceled')
    ) {
      await this.transitionPullStatus(
        {
          ids: input.pullIds,
          from: 'delivering',
          to: input.to === 'completed' ? 'delivered' : 'vaulted',
        },
        sharedContext,
      );
    }

    // Reverse the CREATE-time OD debit — ONE hook covers both the customer
    // cancel route and the admin bulk "mark as canceled" tool, since both
    // route through this method. Nothing fires on 'completed': those cards
    // are gone for good, so the original debit stands permanently.
    //
    // The credit is gated on the CREATE-time debit ROW EXISTING, not on any
    // field of the order — the invariant is existence-based. Crediting the
    // vault back for an order that was never debited drifts the ledger's
    // cumulative vault_delta upward forever with no corresponding liability.
    // Two live sources of debit-less orders, both covered by this one check:
    // (a) B7 reward-prize shipments — recordRewardWithdrawal (this file)
    // creates those with NO OD debit, since reward pulls are excluded from
    // ledger/value tracking everywhere (e.g. Pull.recorded_value_usd);
    // (b) EVERY ordinary order already sitting in requested/processed/
    // ready_to_ship when this ships — D4 is go-forward-only with no backfill,
    // so those carry is_reward=false AND no debit. Runs on the same `em`
    // (this transaction), so it takes no extra pool connection.
    if (input.to === 'canceled' && input.pullIds.length) {
      const [debit] = await em.execute<
        { id: string; vault_delta: string | number | null }[]
      >(
        "SELECT id, vault_delta FROM ledger_entry WHERE type = 'OD' AND ref_id = ? AND deleted_at IS NULL LIMIT 1",
        [input.orderId],
      );
      if (debit) {
        // NEGATE THE STORED DEBIT — never re-value the cards at cancel time.
        // An order sits in 'requested' for days while PriceCharting syncs FMV
        // on a schedule and admins edit market_multiplier, so a cancel-time
        // vaultValueForPulls would price the same cards at a different
        // instant: the round trip is a no-op on actual holdings, yet it would
        // write a permanent, silent non-zero net to cumulative vault_delta
        // with nothing underlying it. Reversing the whole stored amount is
        // unconditionally correct here because this method is the ONE seam
        // every transition routes through (updateDeliveryOrderInvoke) and its
        // caller pages the order's item set to exhaustion — there is no
        // partial cancel to reverse a fraction of.
        const stored = Number(debit.vault_delta);
        if (!Number.isFinite(stored)) {
          // The create arm always writes a finite number, so this is real data
          // corruption. Fail closed: a NaN on a money reversal is worse than a
          // refused cancel.
          throw new MedusaError(
            MedusaError.Types.UNEXPECTED_STATE,
            `OD debit '${debit.id}' for order '${input.orderId}' has a non-numeric vault_delta — refusing to reverse it.`,
          );
        }
        // Still needed for the payload's handle tally (countByHandle) — the
        // reversal amount no longer comes from these rows.
        const pulls = await this.listPulls(
          { id: input.pullIds },
          { take: input.pullIds.length },
          sharedContext,
        );
        await this.recordLedgerEntry(
          {
            type: 'OD',
            customerId: order.customer_id,
            refId: `cancel:${input.orderId}`,
            walletDelta: 0,
            vaultDelta: -stored,
            payload: {
              type: 'OD',
              handles: countByHandle(pulls.map((p) => p.card_id)),
              status: 'canceled',
            },
          },
          sharedContext,
        );
      }
    }
    return { status: input.to };
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
    // `amount` here is mutateCreditAtomic's own cent-rounded value (matches
    // the SUM(ROUND(...)) actually persisted to credit_transaction) — used
    // below for the ledger row so it can't drift from input.amount when this
    // method is called directly (bypassing the HTTP route's epsilon gate),
    // same fix as Task 4's topUpCreditsWithLedger. The audit "before" calc
    // and the return value below intentionally keep input.amount — untouched,
    // out of this fix's scope.
    const { id, balance, amount } = await this.mutateCreditAtomic(
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
    await this.recordLedgerEntry(
      {
        type: 'AD',
        customerId: input.customerId,
        refId: id, // the credit_transaction id already in scope
        walletDelta: amount,
        vaultDelta: null,
        payload: {
          type: 'AD',
          admin_id: input.adminId,
          reason: input.note,
          detail: null,
          card_handle: null,
        },
      },
      sharedContext,
    );
    return { id, amount: input.amount, balance };
  }

  // Wraps the buyback credit insert with its paired SE ledger row, same
  // transaction. sp_ref_id links back to the ORIGINAL pack-open (if the pull
  // still carries its open_id — reward pulls and pre-open_id-era rows won't),
  // matching the spec's "[SP id]" payload field.
  //
  // vaultDelta / payload.price are the card's full display value (valueMyr —
  // computed at buyback-pull.ts:136, already FX+multiplier-applied, threaded
  // in here), NOT input.amount (the buyback PAYOUT — percent of valueMyr).
  // Corrected per Task 7 review: a payout-based vaultDelta is unimplementable
  // for the OD writer (physical delivery has no buyback rate to apply — see
  // task-7-report.md), and it silently drops the house spread out of every
  // pull-then-sell round trip. wallet_delta stays input.amount — that IS the
  // real cash paid, unchanged.
  @InjectTransactionManager()
  async recordBuybackCreditTransaction(
    input: {
      customerId: string;
      amount: number;
      valueMyr: number;
      pullId: string;
      cardHandle: string;
      rate: number;
      openId: string | null;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<
    Awaited<ReturnType<PacksModuleService['createCreditTransactions']>>
  > {
    const rows = await this.createCreditTransactions(
      [
        {
          customer_id: input.customerId,
          amount: input.amount,
          reason: 'buyback' as const,
          pull_id: input.pullId,
        },
      ],
      sharedContext,
    );
    await this.recordLedgerEntry(
      {
        type: 'SE',
        customerId: input.customerId,
        refId: rows[0].id,
        walletDelta: input.amount,
        vaultDelta: -input.valueMyr,
        payload: {
          type: 'SE',
          card_handle: input.cardHandle,
          sp_ref_id: input.openId,
          price: input.valueMyr,
          rate: input.rate,
        },
      },
      sharedContext,
    );
    return rows;
  }

  // recordLedgerEntry — THE write primitive for POLYCARD-BACK §5. Every
  // writer in this epic calls this from WITHIN its own
  // @InjectTransactionManager() method, passing that method's sharedContext,
  // so the ledger row lands in the SAME transaction as the domain write it
  // describes (never called bare — a bare call opens its own transaction,
  // which breaks "same DB transaction as the source write").
  //
  // Idempotency: an explicit pre-check via raw SQL (fires immediately, like
  // settleOpen's own pre-check) rather than catching a unique-violation from
  // an ORM insert — MikroORM's Unit of Work buffers ORM creates until flush
  // (transaction commit), so a 23505 from createLedgerEntries would surface
  // AFTER this method returns, where it can't be handled cleanly.
  //
  // The (type, ref_id) partial unique index backs TWO distinct failure
  // paths, and a caller-side lock only guards ONE of them:
  //   1. CROSS-transaction race: two different callers/transactions racing
  //      the same (type, ref_id) with no shared outer lock. Under READ
  //      COMMITTED, the loser's pre-check can miss the winner's still-
  //      uncommitted row, so the loser proceeds and its own insert 23505s at
  //      flush, aborting the loser's entire transaction. Every real caller
  //      in this epic holds a lock that prevents this (the per-customer
  //      credit lock or the per-order delivery lock).
  //   2. SAME-transaction self-duplication: a batch/loop writer that calls
  //      this method twice with the same (type, ref_id) inside ONE already-
  //      open transaction — e.g. a hypothetical Epic 6 payout job iterating
  //      a list of commissions with ref_id = commission.id. The SAME UoW
  //      buffering that motivated the raw-SQL pre-check also makes that
  //      pre-check BLIND to the first call's still-unflushed insert (raw SQL
  //      sees flushed/committed table state, never the UoW's pending
  //      creates), so the second call sees nothing, proceeds, and queues a
  //      second insert with the same (type, ref_id). That insert 23505s at
  //      flush, hard-aborting the WHOLE transaction instead of returning a
  //      graceful `replayed: true`.
  // A caller-side lock guards ONLY path 1 — it does nothing for path 2.
  // Per-transaction ref_id uniqueness is the CALLER's own responsibility:
  // de-duplicate ref_ids in your input BEFORE looping calls to this method
  // inside one transaction. This method will not do it for you — doing so
  // would require either flushing mid-transaction or tracking written refs
  // in memory, both out of scope here (and likely to mask a real bug in the
  // caller, e.g. a genuinely duplicated commission row upstream).
  @InjectTransactionManager()
  async recordLedgerEntry(
    input: {
      type: LedgerType;
      customerId: string;
      refId: string;
      walletDelta: number | null;
      vaultDelta: number | null;
      payload: LedgerPayload;
      occurredAt?: Date;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ id: string; display_id: string; replayed: boolean }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const occurredAt = input.occurredAt ?? new Date();

    const [existing] = await em.execute<{ id: string; display_id: string }[]>(
      'SELECT id, display_id FROM ledger_entry WHERE type = ? AND ref_id = ? AND deleted_at IS NULL LIMIT 1',
      [input.type, input.refId],
    );
    if (existing) {
      return {
        id: existing.id,
        display_id: existing.display_id,
        replayed: true,
      };
    }

    const scope = sequenceScope(input.type, occurredAt);

    // Upsert-then-lock: a brand-new scope has no row for FOR UPDATE to hold,
    // so create it first (ON CONFLICT DO NOTHING absorbs a concurrent
    // first-writer race on the SAME fresh scope), then lock + read whoever's
    // row won.
    await em.execute(
      'INSERT INTO ledger_sequence (id, scope, last_serial, created_at, updated_at) ' +
        'VALUES (?, ?, NULL, now(), now()) ON CONFLICT (scope) WHERE deleted_at IS NULL DO NOTHING',
      [randomUUID(), scope],
    );
    const [seqRow] = await em.execute<
      { id: string; last_serial: string | null }[]
    >(
      'SELECT id, last_serial FROM ledger_sequence WHERE scope = ? AND deleted_at IS NULL FOR UPDATE',
      [scope],
    );
    // The upsert above guarantees a row, so this is unreachable — but an
    // undefined here would surface as a bare TypeError from nextSerial rather
    // than something an operator can act on. Fail closed with a named error.
    if (!seqRow) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Ledger sequence scope '${scope}' could not be locked for serial allocation.`,
      );
    }
    const serial = nextSerial(seqRow.last_serial);
    await em.execute(
      'UPDATE ledger_sequence SET last_serial = ?, updated_at = now() WHERE id = ?',
      [serial, seqRow.id],
    );

    const id = input.type + '_' + randomUUID(); // any unique text works; MedusaService ids are opaque anyway
    const [row] = await this.createLedgerEntries(
      [
        {
          id,
          display_id: displayId(input.type, occurredAt, serial),
          type: input.type,
          customer_id: input.customerId,
          occurred_at: occurredAt,
          wallet_delta: input.walletDelta,
          vault_delta: input.vaultDelta,
          payload: input.payload,
          ref_id: input.refId,
        },
      ],
      sharedContext,
    );
    return { id: row.id, display_id: row.display_id, replayed: false };
  }

  // Compensation-only delete by (type, ref_id) — every writer's workflow-step
  // compensation (Tasks 4-8) calls THIS, not the raw generated method, so the
  // `as never` escape lives in exactly one place. Precedent:
  // deleteCreditTransactionsGuarded (~line 3415) casts the same way — the
  // MedusaService-generated delete accepts a filter selector at runtime, but
  // its generated TS signature only declares id/id[]. This is for IN-FLIGHT
  // workflow rollback only (see Global Constraints' two-mechanisms note) —
  // never call it to "fix" a settled row.
  async deleteLedgerEntryByRef(type: LedgerType, refId: string): Promise<void> {
    await this.deleteLedgerEntries({ type, ref_id: refId } as never);
  }

  // The admin Transactions list (POLYCARD-BACK §5.4). Raw SQL because `q` is an
  // OR across display_id and the customer-name/email match resolved by the
  // CALLER (the customer table lives in another module — no join available),
  // which a plain ORM AND-filter can't express.
  //
  // Sequential, not Promise.all: this resolves transactionManager ?? manager,
  // so it can run inside an ambient transaction — two concurrent executes on
  // one transactional connection is this repo's "pool is probably full" shape.
  //
  // Every WHERE shape here is indexed: the unfiltered default view by
  // IDX_ledger_entry_occurred_at (Migration20260728211500 — added before the
  // table had volume, since a non-concurrent CREATE INDEX on a busy
  // ledger_entry would block the pack-open write path), the tabs by
  // IDX_ledger_entry_type_occurred_at. `display_id ILIKE '%q%'` can never use
  // the unique btree (leading wildcard) — inherent to substring search, not an
  // index gap.
  @InjectManager()
  async listLedgerEntriesForAdmin(
    input: {
      type?: LedgerType;
      q?: string;
      matchingCustomerIds?: string[];
      from?: Date;
      to?: Date;
      limit: number;
      offset: number;
      // Optional explicit ordering. The key is a closed union AND re-mapped
      // through LEDGER_SORT_COLS below before touching SQL — this method
      // string-concatenates ORDER BY, so nothing caller-supplied may ever be
      // interpolated directly.
      sort?: {
        key: 'occurred_at' | 'display_id' | 'type';
        dir: 'ASC' | 'DESC';
      };
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ entries: LedgerEntryRow[]; total: number }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const clauses: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (input.type) {
      clauses.push('type = ?');
      params.push(input.type);
    }
    if (input.from) {
      clauses.push('occurred_at >= ?');
      params.push(input.from);
    }
    if (input.to) {
      // EXCLUSIVE. The caller hands us a half-open [from, to) window
      // (parseMytBound turns `to=YYYY-MM-DD` into the NEXT MYT midnight), so
      // `<=` here would spill one row-instant into the following day.
      clauses.push('occurred_at < ?');
      params.push(input.to);
    }
    if (input.q) {
      const ids = input.matchingCustomerIds ?? [];
      const idClause = ids.length
        ? ` OR customer_id IN (${ids.map(() => '?').join(',')})`
        : '';
      clauses.push(`(display_id ILIKE ?${idClause})`);
      params.push(`%${input.q}%`, ...ids);
    }
    const where = clauses.join(' AND ');
    // Fixed lookup table, NOT input.sort.key itself: the ORDER BY below is
    // string-built, so the column name must come from OUR literal, with the
    // typed key acting only as the lookup. `id` tiebreaker for stable paging.
    const LEDGER_SORT_COLS = {
      occurred_at: 'occurred_at',
      display_id: 'display_id',
      type: 'type',
    } as const;
    const sortCol = LEDGER_SORT_COLS[input.sort?.key ?? 'occurred_at'];
    const sortDir = input.sort?.dir === 'ASC' ? 'ASC' : 'DESC';
    const entries = await em.execute<LedgerEntryRow[]>(
      'SELECT id, display_id, type, customer_id, occurred_at, wallet_delta, vault_delta, payload ' +
        `  FROM ledger_entry WHERE ${where} ` +
        `  ORDER BY ${sortCol} ${sortDir}, id ${sortDir} LIMIT ? OFFSET ?`,
      [...params, input.limit, input.offset],
    );
    const countRows = await em.execute<{ n: string }[]>(
      `SELECT COUNT(*)::bigint AS n FROM ledger_entry WHERE ${where}`,
      params,
    );
    return { entries, total: Number(countRows[0]?.n ?? 0) };
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

  // Monotonic lifetime VIP turnover for a single customer, in SEN: full
  // pack_open spend regardless of funding source (2026-07-22 turnover-VIP —
  // winnings-funded opens count; commissions/playthrough gate still use the
  // external-funded basis). Sums ORIGINAL pack_open debits (amount<0) only —
  // reversals are amount>0 and thus excluded, so the counter never drops on a
  // clawback (spec §3).
  // This mirrors the `lifetimeTurnoverSen` pure fold but runs in raw SQL for
  // efficiency (one scan vs. N ORM fetches). Uses @InjectManager so a caller
  // outside a transaction gets a fresh connection.
  @InjectManager()
  async lifetimeTurnoverSenFor(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<number> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const rows = await em.execute<{ sen: string | null }[]>(
      // Debits ONLY (`amount < 0`) — deliberate, and recorded in ADR 0003 under
      // "Reversal exclusion". vip-lifetime.ts's lifetimeTurnoverSen is the
      // pure-fold mirror that has to agree with this SQL; netting one and not
      // the other desyncs the tests from production silently, which is exactly
      // what a previous attempt at fixing this line did.
      //
      // What this filter is NOT is the re-grant guard, and mis-stating that has
      // already cost one bad change. Re-granting a level is impossible at the
      // DB: grantLevelUpRewards inserts ON CONFLICT (customer_id, level, kind)
      // DO NOTHING against UQ_vip_reward_grant_customer_level_kind. Two further
      // guards sit above it — highest_level_ever is a GREATEST ratchet, and
      // levelsToGrant starts at max(highestEver + 1, 2), so a LOWER level
      // yields an empty list. None of the three depends on how this counter is
      // summed.
      //
      // Reversals DO move the system, on the other basis:
      // creditSummary().vipSpendTotal is net, drops on reversal, and drives
      // current_level. This monotonic one feeds highest_level_ever.
      //
      // Three audit passes have flagged `amount < 0` as a bug and one got as
      // far as changing it. WON'T-FIX — ADR 0003, "Reversal exclusion".
      `SELECT COALESCE(SUM(ROUND(-amount * 100)), 0)::bigint AS sen
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
  // lifetime turnover counter (SEN), the net turnover spend (MYR, the display axis),
  // and the full ladder (threshold + reward columns). Both rebuildVipMemberState
  // and grantLevelUpRewards need exactly these, so they live in one place and can
  // never drift in what they read. Reads stay SEQUENTIAL: lifetimeTurnoverSenFor
  // and listVipLevels run on the same injected EntityManager, which is not safe to
  // query concurrently — so this is a DRY extraction, not a parallelization.
  private async loadVipStateInputs(
    customerId: string,
    sharedContext: Context = {},
  ) {
    const lifetimeSen = await this.lifetimeTurnoverSenFor(
      customerId,
      sharedContext,
    );
    const netBasisMyr = (await this.creditSummary(customerId)).vipSpendTotal;
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

  // Distinct customers that have ever touched the credit ledger — shared by
  // rebuildAllVipMemberState and the turnover reconciliation script.
  @InjectManager()
  async listLedgerCustomerIds(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<string[]> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const rows = await em.execute<{ customer_id: string }[]>(
      `SELECT DISTINCT customer_id FROM credit_transaction WHERE deleted_at IS NULL`,
      [],
    );
    return rows.map((r) => r.customer_id);
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

  // ── External-basis backfill (pre-1b grandfathered deposits) ───────────────
  // Migration20260621120000 added external_funded_cents; topups written BEFORE
  // it are NULL and the live paths grandfather them OUT of the external
  // balance, so every open funded by them stamps 0 and the customer's VIP
  // basis never moves. This backfill flips those topups to their face value
  // and replays consumption over the customer's chronological ledger with the
  // exact live arithmetic (recomputeExternalStamps), then re-runs the ladder
  // grant so crossed rungs settle. Idempotent: an already-correct ledger
  // yields an empty diff and grantLevelUpRewards gains nothing.
  //
  // NOTE: stamping a topup also moves it INTO the deposited-playthrough basis
  // (plan 033/038), so affected customers' withdrawable gates tighten to
  // "deposits fully played through" — accepted trade-off of the backfill.
  @InjectManager()
  async backfillExternalFundedBasis(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    customers: number;
    rowsUpdated: number;
    leveled: Record<string, number[]>;
  }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const customers = await em.execute<{ customer_id: string }[]>(
      `SELECT DISTINCT customer_id FROM credit_transaction
        WHERE reason = 'topup' AND amount > 0
          AND external_funded_cents IS NULL AND deleted_at IS NULL`,
      [],
    );
    let rowsUpdated = 0;
    const leveled: Record<string, number[]> = {};
    for (const { customer_id } of customers) {
      const r = await this.backfillExternalFundedBasisForCustomer(customer_id);
      rowsUpdated += r.rowsUpdated;
      // Grant AFTER the stamp txn commits (mirrors settleVipStep): the shared
      // VIP-state readers (creditSummary is context-less @InjectManager) run on
      // fresh connections and would not see this txn's uncommitted stamps.
      const { gained } = await this.grantLevelUpRewards(
        customer_id,
        'external-backfill',
      );
      if (gained.length > 0) leveled[customer_id] = gained;
    }
    return { customers: customers.length, rowsUpdated, leveled };
  }

  // One customer's replay, in ONE locked transaction: advisory credit-lock
  // (serializes against live opens/topups/reversals), recompute, stamp. The
  // ladder grant runs from the orchestrator AFTER this txn commits — its
  // readers (context-less creditSummary) use fresh connections and cannot see
  // uncommitted stamps.
  @InjectTransactionManager()
  async backfillExternalFundedBasisForCustomer(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ rowsUpdated: number }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);
    const rows = await em.execute<
      {
        id: string;
        reason: string;
        amount: string;
        external_funded_cents: number | string | null;
        reference: string | null;
      }[]
    >(
      `SELECT id, reason, amount, external_funded_cents, reference
         FROM credit_transaction
        WHERE customer_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
      [customerId],
    );
    const diff = recomputeExternalStamps(
      rows.map((r) => ({
        id: r.id,
        reason: r.reason,
        amount: Number(r.amount),
        external_funded_cents:
          r.external_funded_cents === null
            ? null
            : Number(r.external_funded_cents),
        reference: r.reference,
      })),
    );
    for (const [id, ext] of diff) {
      await em.execute(
        'UPDATE credit_transaction SET external_funded_cents = ?, updated_at = now() WHERE id = ?',
        [ext, id],
      );
    }
    return { rowsUpdated: diff.size };
  }

  // Grant ladder rewards for every newly-crossed VIP level (Phase 3b §E).
  //
  // Monotonic-grant invariant: derives the trigger level from the MONOTONIC
  // lifetime counter (lifetimeTurnoverSenFor → fromSen → levelForSpend) so
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
  // currentLevel uses the NET turnover basis (creditSummary.vipSpendTotal) so
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
  // Shape (plan 021): this enumerator runs OUTSIDE any transaction (@InjectManager,
  // plain read) and delegates each beneficiary to
  // matureDueCommissionsForBeneficiary, which opens its OWN short transaction and
  // holds exactly one credit: advisory lock for its duration. Invariant to
  // protect: at most one credit: advisory lock held per transaction, ever —
  // never forward this method's sharedContext into the per-beneficiary calls,
  // or they would join one outer transaction and re-accumulate locks across
  // beneficiaries (blocking every money path behind the batch until commit).
  //
  // Notifications fire AFTER each beneficiary's transaction commits, and are
  // best-effort: the flip is already committed; the notification is feed-only
  // and idempotent (`${commissionId}:matured`), so a failed notify must not
  // abort the remaining beneficiaries — and can never roll back flips anymore.
  // A crash between commit and notify means a missed notification (acceptable,
  // feed-only); a re-run cannot double-notify.
  @InjectManager()
  async matureDueCommissions(
    notify?: (
      beneficiaryId: string,
      commissionId: string,
      frozen: boolean,
    ) => Promise<void>,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ flipped: number }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;

    // 1) Enumerate all distinct beneficiaries that have at least one due pending row.
    //    COLLATE "C" forces byte-order (C locale) sort on the outer ORDER BY,
    //    matching JS plain Array.sort() (UTF-16 lexicographic). With one advisory
    //    lock per (per-beneficiary) transaction the old AB-BA deadlock vector
    //    against reverseOpen/reverseCommission is gone — the ordering is retained
    //    for deterministic processing order only.
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
      // One SHORT transaction per beneficiary (deliberately no sharedContext —
      // see the invariant in the method comment above).
      const result = await this.matureDueCommissionsForBeneficiary(beneficiary);
      flipped += result.flipped;

      if (!notify) continue;
      for (const id of result.flippedIds) {
        try {
          await notify(beneficiary, id, result.frozen);
        } catch (err) {
          // Best-effort (see method comment): flip already committed, feed-only,
          // idempotent — log and keep going.
          // eslint-disable-next-line no-console
          console.warn(
            '[matureDueCommissions] notify failed (flip already committed)',
            { beneficiary, commission_id: id, error: String(err) },
          );
        }
      }
    }

    return { flipped };
  }

  // Per-beneficiary maturity flip: ONE beneficiary, ONE short transaction, ONE
  // credit: advisory lock (same keyspace as mutateCreditAtomic / settleOpen) so
  // concurrent reversal writes on the same beneficiary are serialized. Uses
  // SKIP LOCKED chunked UPDATEs so a second concurrent run skips already-locked
  // rows rather than blocking.
  //
  // Status-guarded (status='pending' in WHERE) → idempotent, never clobbers
  // reversed/suspended rows. Returns the flipped ids so the caller can notify
  // AFTER this transaction commits — no notify call belongs inside this method.
  @InjectTransactionManager()
  private async matureDueCommissionsForBeneficiary(
    beneficiary: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ flipped: number; flippedIds: string[]; frozen: boolean }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const CHUNK = 500;

    // 2) Acquire the per-beneficiary advisory lock (same credit: keyspace used by
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
    const flippedIds: string[] = [];
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

      for (const r of rows) flippedIds.push(r.id);

      if (rows.length < CHUNK) break;
    }

    return { flipped: flippedIds.length, flippedIds, frozen };
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
    if (vipLevel) return vipLevel.box_tier;
    // No exact rung: the admin shrank the ladder below this member's monotonic
    // peak (legal since the Levels tab landed). Clamp to the top rung so the
    // daily box keeps resolving instead of going 'unavailable' forever.
    const [top] = await this.listVipLevels(
      {},
      { order: { level: 'DESC' }, take: 1 },
      sharedContext,
    );
    return top?.box_tier ?? '';
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

    // 3) Roll over the box's stored weights (locked rows included). The bound
    // is the ACTUAL Σweight, not a fixed constant, so the draw is
    // scale-invariant like the pack roll — rows saved on either side of the
    // 4dp scale migration roll correctly.
    const totalPrizeWeight = prizeRows.reduce((s, p) => s + p.weight, 0);
    const roll = randomInt(Math.max(1, totalPrizeWeight));
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
      draw_day: drawDay,
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
        pct: p.weight / PCT_SCALE,
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

  // Audited whole-set replace of the VIP ladder. Diff-upsert keyed on `level`:
  // update survivors in place (ids + prizes preserved), create new rungs
  // (prizes null), HARD-delete removed rungs (a soft row keeps the unique
  // `level` and would collide on recreate). box_tier existence is checked here
  // (service-level DB lookup, not in the pure validator). One audit row.
  @InjectTransactionManager()
  async saveVipLevels(
    input: { levels: VipLevelInput[]; adminId: string; reason: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<VipLevelInput[]> {
    const boxes = await this.listRewardBoxes(
      {},
      { select: ['tier'], take: 1000 },
      sharedContext,
    );
    const validTiers = new Set(boxes.map((b) => b.tier));
    for (const lvl of input.levels) {
      if (!validTiers.has(lvl.box_tier)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `level ${lvl.level}: box_tier '${lvl.box_tier}' is not an existing reward box tier.`,
        );
      }
    }

    const existing = await this.listVipLevels(
      {},
      {
        select: [
          'id',
          'level',
          'spend_threshold',
          'voucher_amount',
          'box_tier',
          'frame_unlock',
          'direct_referral_pct',
        ],
        take: 1000,
      },
      sharedContext,
    );
    const byLevel = new Map(existing.map((r) => [r.level, r]));
    const before = existing
      .slice()
      .sort((a, b) => a.level - b.level)
      .map((r) => ({
        level: r.level,
        spend_threshold: Number(r.spend_threshold),
        voucher_amount: Number(r.voucher_amount),
        box_tier: r.box_tier,
        frame_unlock: r.frame_unlock,
        direct_referral_pct: r.direct_referral_pct,
      }));

    const inputLevels = new Set(input.levels.map((l) => l.level));
    for (const lvl of input.levels) {
      const data = {
        spend_threshold: lvl.spend_threshold,
        voucher_amount: lvl.voucher_amount,
        box_tier: lvl.box_tier,
        frame_unlock: lvl.frame_unlock,
        direct_referral_pct: lvl.direct_referral_pct,
      };
      const row = byLevel.get(lvl.level);
      if (row) {
        await this.updateVipLevels(
          { selector: { id: row.id }, data },
          sharedContext,
        );
      } else {
        await this.createVipLevels(
          [{ level: lvl.level, ...data, prizes: null }],
          sharedContext,
        );
      }
    }

    const removedIds = existing
      .filter((r) => !inputLevels.has(r.level))
      .map((r) => r.id);
    if (removedIds.length > 0) {
      await this.deleteVipLevels(removedIds, sharedContext);
    }

    const after = input.levels.map((l) => ({ ...l }));
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'vip_levels',
          entity_id: 'singleton',
          action: 'replace',
          // before/after are `json` columns typed Record<string, unknown> |
          // null, not arrays — wrap the ladder snapshot under a key.
          before: { levels: before },
          after: { levels: after },
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return after;
  }

  // Audited whole-set replace of the challenge milestone stages. Diff-upsert
  // keyed on `stage_number`, hard-delete removed rows (soft would collide on
  // the unique key). Prize-card EXISTENCE is checked here (service-level).
  @InjectTransactionManager()
  async saveChallengeStages(
    input: { stages: ChallengeStageInput[]; adminId: string; reason: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<ChallengeStageInput[]> {
    const allCardIds = [
      ...new Set(
        input.stages.flatMap((s) =>
          s.rank_rewards
            .map((r) => r.card_id)
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    ];
    if (allCardIds.length > 0) {
      const found = await this.listCards(
        { id: allCardIds },
        { select: ['id'], take: allCardIds.length },
        sharedContext,
      );
      const foundIds = new Set(found.map((c) => c.id));
      const missing = allCardIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0)
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Unknown featured card id(s): ${missing.join(', ')}.`,
        );
    }

    const existing = await this.listChallengeStages(
      {},
      {
        select: ['id', 'stage_number', 'threshold_myr', 'rank_rewards'],
        take: 1000,
      },
      sharedContext,
    );
    const byStage = new Map(existing.map((r) => [r.stage_number, r]));
    const before = existing
      .slice()
      .sort((a, b) => a.stage_number - b.stage_number)
      .map((r) => ({
        stage_number: r.stage_number,
        threshold_myr: Number(r.threshold_myr),
        rank_rewards:
          (r.rank_rewards as unknown as ChallengeRankReward[]) ?? [],
      }));

    const inputStages = new Set(input.stages.map((s) => s.stage_number));
    for (const s of input.stages) {
      const data = {
        threshold_myr: s.threshold_myr,
        // model.json() generates a Record<string, unknown> create/update input
        // type — a plain array has no string index signature, so it needs the
        // same double-cast update-pack.ts / seed-pixel-pokemon.ts use for their
        // json columns; the DB just stores the array.
        rank_rewards: s.rank_rewards as unknown as Record<string, unknown>,
      };
      const row = byStage.get(s.stage_number);
      if (row) {
        await this.updateChallengeStages(
          { selector: { id: row.id }, data },
          sharedContext,
        );
      } else {
        await this.createChallengeStages(
          [{ stage_number: s.stage_number, ...data }],
          sharedContext,
        );
      }
    }

    const removedIds = existing
      .filter((r) => !inputStages.has(r.stage_number))
      .map((r) => r.id);
    if (removedIds.length > 0) {
      await this.deleteChallengeStages(removedIds, sharedContext);
    }

    const after = input.stages.map((s) => ({ ...s }));
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'challenge_stages',
          entity_id: 'singleton',
          action: 'replace',
          // before/after are `json` columns typed Record<string, unknown> |
          // null, not arrays — wrap the stage-list snapshot under a key (same
          // discipline as saveVipLevels' { levels: ... } wrap).
          before: { stages: before },
          after: { stages: after },
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return after;
  }

  // Promote every challenge_schedule row whose start has passed into the LIVE
  // stage table, oldest first, and stamp it applied.
  //
  // Oldest-first matters: if the job missed a tick and two editions came due,
  // replaying them in order leaves the newest one live, which is what the
  // operator queued. Each promotion is its own transaction (@InjectManager
  // here, saveChallengeStages opens its own) so one bad edition — a prize card
  // deleted since it was queued — cannot roll back the ones that already
  // landed. That row simply stays unapplied and is retried next hour, which is
  // the loud-but-recoverable state: the operator sees it stuck in the Scheduled
  // tab rather than silently losing a week's prizes.
  //
  // `applied_at` is the idempotency gate — the filter below excludes stamped
  // rows, so re-running this is a no-op.
  //
  // No advisory lock, unlike the sibling writes in this service: the promotion
  // runs from ONE place, the settle-challenge-week cron, and the worker that
  // runs it is `instance_count: 1` under a split MEDUSA_WORKER_MODE (see
  // .do/backend.app.yaml). Scaling that worker past one would let two runs both
  // read `applied_at: null` and double-write the live stage table — take a lock
  // here before doing that.
  //
  // The save and its `applied_at` stamp share ONE transaction per row
  // (promoteOneChallengeSchedule). Separately, a stamp failure would leave the
  // ladder replaced but the row still due — and the next hour's retry would
  // then overwrite whatever an operator edited in between. Per-row rather than
  // per-batch, so the failure isolation below is unaffected: one bad edition
  // rolls back alone.
  @InjectManager()
  async promoteDueChallengeSchedules(
    now: Date = new Date(),
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ promoted: number; failed: number }> {
    const due = await this.listChallengeSchedules(
      { applied_at: null, starts_at: { $lte: now } },
      {
        select: ['id', 'starts_at', 'label', 'stages'],
        order: { starts_at: 'ASC' },
        take: 100,
      },
      sharedContext,
    );
    let promoted = 0;
    let failed = 0;
    for (const row of due) {
      try {
        // Context MUST be threaded: without it the callee's
        // @InjectTransactionManager has no manager to inherit and no repository
        // to open one from. In production this carries a plain read context, so
        // each row opens its OWN transaction — which is exactly the per-row
        // atomicity wanted.
        //
        // `false` means the row vanished or stopped being due between the list
        // above and the locked re-read inside — an operator removed or
        // rescheduled it mid-batch. Not promoted, not failed: there is nothing
        // left to retry.
        if (await this.promoteOneChallengeSchedule(row.id, now, sharedContext))
          promoted += 1;
      } catch {
        // Swallowed on purpose: a later edition must still get its chance, and
        // the unstamped row IS the error report (visible in the admin, retried
        // hourly). The caller logs the count.
        failed += 1;
      }
    }
    return { promoted, failed };
  }

  /**
   * One edition: replace the live stages and stamp the row applied, in a single
   * transaction.
   *
   * Both writes or neither. If the stamp failed on its own, the ladder would
   * already be replaced while the row stayed due — and the next hourly retry
   * would re-run saveChallengeStages, silently reverting any edit an operator
   * made to the live ladder in the meantime.
   *
   * The row is RE-READ here, under FOR UPDATE, rather than trusted from the
   * caller's list: an admin edit or delete can land between that list and this
   * transaction, and promoting the captured copy would push stale stages live
   * (or resurrect a just-removed edition) while the admin route had already
   * reported success. The lock closes the other half too — an edit that
   * arrives DURING this transaction blocks on the row, then its
   * `applied_at: null` selector matches nothing and the route reports "went
   * live while you were editing" instead of a false success. A row that is
   * gone, already stamped, or no longer due answers `false`: nothing to do.
   *
   * The stage write goes through the normal save path, NOT a raw write: that is
   * what validates the prize cards still exist and what writes the audit row,
   * so a promoted edition is indistinguishable from a hand-saved one. Both
   * callees are @InjectTransactionManager and receive this method's context, so
   * they join this transaction rather than opening their own.
   */
  @InjectTransactionManager()
  async promoteOneChallengeSchedule(
    id: string,
    now: Date,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<boolean> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const [fresh] = await em.execute<
      {
        id: string;
        starts_at: Date | string;
        label: string | null;
        stages: unknown;
      }[]
    >(
      `SELECT id, starts_at, label, stages
         FROM challenge_schedule
        WHERE id = ? AND applied_at IS NULL AND deleted_at IS NULL
          FOR UPDATE`,
      [id],
    );
    if (!fresh || new Date(fresh.starts_at).getTime() > now.getTime())
      return false;
    await this.saveChallengeStages(
      {
        stages: (fresh.stages as ChallengeStageInput[]) ?? [],
        adminId: 'system',
        reason: `Scheduled challenge promoted (${fresh.label ?? new Date(fresh.starts_at).toISOString()})`,
      },
      sharedContext,
    );
    // Selector repeats the unapplied condition out of the same discipline as
    // the admin routes — under the row lock it cannot actually lose, but an
    // id-only stamp is the exact shape this method exists to forbid.
    await this.updateChallengeSchedules(
      { selector: { id, applied_at: null }, data: { applied_at: new Date() } },
      sharedContext,
    );
    return true;
  }

  /**
   * Edit a QUEUED edition in place — new start, name, prize ladder — with the
   * conflict check, the write, and its audit row in ONE transaction.
   *
   * Same FOR UPDATE idiom as promoteOneChallengeSchedule, and against the same
   * rivals: the row lock serializes this edit against the hourly promotion
   * (an edit arriving while a promotion holds the row blocks, then reads
   * `applied_at` and refuses) and against another operator's concurrent
   * edit/delete (they apply one after the other, each auditing the state it
   * actually replaced — `before` can never skip an intervening write).
   *
   * The audit insert shares the transaction, so a failed audit rolls the
   * schedule change back with it: no edit can land unrecorded.
   */
  @InjectTransactionManager()
  async editChallengeSchedule(
    input: {
      id: string;
      startsAt: Date;
      label: string | null;
      stages: ChallengeStageInput[];
      adminId: string;
      reason: string;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    // No `applied_at IS NULL` in the WHERE: a promoted row must be READ and
    // refused with the right message, not skipped as if it never existed.
    const [row] = await em.execute<
      {
        id: string;
        starts_at: Date | string;
        label: string | null;
        stages: unknown;
        applied_at: Date | string | null;
      }[]
    >(
      `SELECT id, starts_at, label, stages, applied_at
         FROM challenge_schedule
        WHERE id = ? AND deleted_at IS NULL
          FOR UPDATE`,
      [input.id],
    );
    if (!row)
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'Scheduled challenge not found.',
      );
    if (row.applied_at)
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'This challenge already went live — edit the live stages instead.',
      );
    // Selector repeats the unapplied condition — same discipline as the stamp
    // above; under the row lock it cannot lose.
    await this.updateChallengeSchedules(
      {
        selector: { id: input.id, applied_at: null },
        data: {
          starts_at: input.startsAt,
          label: input.label,
          // model.json() wants Record<string, unknown>; a plain array has no
          // string index signature (same double-cast as saveChallengeStages).
          stages: input.stages as unknown as Record<string, unknown>,
        },
      },
      sharedContext,
    );
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'challenge_stages',
          entity_id: input.id,
          action: 'edit',
          before: {
            starts_at: new Date(row.starts_at).toISOString(),
            label: row.label,
            stages: row.stages,
          },
          after: {
            starts_at: input.startsAt.toISOString(),
            label: input.label,
            stages: input.stages,
          },
          reason: input.reason,
        },
      ],
      sharedContext,
    );
  }

  // The settled weeks, newest first, with enough per-week summary to drive a
  // selector without loading every payout row.
  //
  // Raw SQL because this is a GROUP BY: the generated list methods return rows,
  // and deriving the week list from them client-side means paging every payout
  // ever written just to learn which weeks exist — the same unbounded-window
  // trap the schedule list had.
  //
  // `skipped` is the reason this read exists at all. A card the settlement
  // could not grant for stock is recorded and then only ever mentioned in a job
  // log line; counting it per week is what turns it into a queue someone can
  // actually work.
  @InjectManager()
  async challengeWinnerWeeks(
    limit = 26,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<
    {
      weekStart: string;
      winners: number;
      credits: number;
      cards: number;
      skipped: number;
    }[]
  > {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const rows = await em.execute<
      {
        week_start: Date;
        winners: string;
        credits: string | null;
        cards: string;
        skipped: string;
      }[]
    >(
      `SELECT week_start,
              COUNT(DISTINCT customer_id) AS winners,
              COALESCE(SUM(credits), 0) AS credits,
              -- GRANTED cards only. A skipped_no_stock row is still kind
              -- 'card', so counting the kind alone reports a card handed over
              -- when none was — on the very week the operator is being told
              -- one is owed.
              COUNT(*) FILTER (
                WHERE kind = 'card' AND status <> 'skipped_no_stock'
              ) AS cards,
              COUNT(*) FILTER (WHERE status = 'skipped_no_stock') AS skipped
         FROM challenge_payout
        WHERE deleted_at IS NULL
        GROUP BY week_start
        ORDER BY week_start DESC
        LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      weekStart: new Date(r.week_start).toISOString(),
      winners: Number(r.winners),
      credits: Number(r.credits ?? 0),
      cards: Number(r.cards),
      skipped: Number(r.skipped),
    }));
  }

  // Community pool for the CURRENT challenge week: Σ pulled value across all
  // customers (recorded draw-time USD value, live FMV × multiplier fallback
  // for pre-backfill rows, × FX → MYR) since the week anchor (shared
  // CHALLENGE_WEEK_ANCHOR_CTE). Mirrors leaderboardTop's wins CTE
  // (source = 'pack' — reward and free pulls excluded); read-only, so the
  // pool is REAL ledger data even while the reward settlement engine is inert.
  @InjectManager()
  async challengeWeekPool(
    opts: ChallengeWeekAnchor,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<number> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const fxRate = await resolveFxRate(this);
    const [row] = await em.execute<{ pooled_myr: string | null }[]>(
      CHALLENGE_WEEK_ANCHOR_CTE +
        'SELECT ' +
        '  ROUND(COALESCE(SUM(' +
        PULLED_VALUE_USD_SQL +
        '), 0) * ? * 100) / 100 AS pooled_myr ' +
        '  FROM pull pu ' +
        '  LEFT JOIN card c ON c.handle = pu.card_id AND c.deleted_at IS NULL ' +
        " WHERE pu.deleted_at IS NULL AND pu.customer_id IS NOT NULL AND pu.source = 'pack' " +
        '   AND pu.rolled_at >= (SELECT start_utc FROM anchor) ' +
        '   AND pu.rolled_at <  (SELECT end_utc FROM anchor)',
      [...challengeWeekAnchorParams(opts), DEFAULT_MARKET_MULTIPLIER, fxRate],
    );
    return Number(row?.pooled_myr ?? 0);
  }

  // Weekly Pull Value top-10 for the challenge: customers ranked by pulled
  // value (NOT spend — that's the main leaderboard's ranking) inside the SAME
  // challenge-week window as challengeWeekPool (shared CHALLENGE_WEEK_ANCHOR_CTE).
  // Standard §"Weekly Pulled Value Challenge": end-of-week top-10 receive the
  // unlocked cumulative rewards.
  @InjectManager()
  async challengeWeekTop(
    opts: ChallengeWeekAnchor & { limit: number },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ customer_id: string; pulls: number; volumeMyr: number }[]> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const fxRate = await resolveFxRate(this);
    const rows = await em.execute<
      { customer_id: string; pulls: string; volume_myr: string | null }[]
    >(
      CHALLENGE_WEEK_ANCHOR_CTE +
        'SELECT pu.customer_id, COUNT(*) AS pulls, ' +
        '       ROUND(SUM(' +
        PULLED_VALUE_USD_SQL +
        ') * ? * 100) / 100 AS volume_myr ' +
        '  FROM pull pu ' +
        '  LEFT JOIN card c ON c.handle = pu.card_id AND c.deleted_at IS NULL ' +
        " WHERE pu.deleted_at IS NULL AND pu.customer_id IS NOT NULL AND pu.source = 'pack' " +
        '   AND pu.rolled_at >= (SELECT start_utc FROM anchor) ' +
        '   AND pu.rolled_at <  (SELECT end_utc FROM anchor) ' +
        ' GROUP BY pu.customer_id ' +
        ' ORDER BY volume_myr DESC NULLS LAST, pu.customer_id ASC ' +
        ' LIMIT ?',
      [
        ...challengeWeekAnchorParams(opts),
        DEFAULT_MARKET_MULTIPLIER,
        fxRate,
        opts.limit,
      ],
    );
    return rows.map((r) => ({
      customer_id: r.customer_id,
      pulls: Number(r.pulls ?? 0),
      volumeMyr: Number(r.volume_myr ?? 0),
    }));
  }

  // Resolve one challenge week's UTC [start, end) — settlement's payout key
  // comes from the SAME CTE as the aggregates, so they can never disagree on
  // the boundary. (All queries in a settlement run execute after the cron
  // fire, which is at-or-after the reset instant — see the spec's
  // boundary-race note.)
  @InjectManager()
  async challengeWeekBounds(
    opts: ChallengeWeekAnchor,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ startUtc: Date; endUtc: Date }> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const [row] = await em.execute<{ start_utc: string; end_utc: string }[]>(
      CHALLENGE_WEEK_ANCHOR_CTE + 'SELECT start_utc, end_utc FROM anchor',
      challengeWeekAnchorParams(opts),
    );
    // No row = the anchor CTE resolved nothing (misconfigured
    // challenge_settings, e.g. an unknown timezone). Fail loud, naming the
    // inputs, so the job log says WHY: settlement must never fall back to a
    // fabricated week — a wrong boundary pays the wrong people.
    if (!row) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Challenge week anchor resolved no row — check challenge_settings ` +
          `(timezone '${opts.timezone}', resetDay ${opts.resetDay}, ` +
          `resetHour ${opts.resetHour}, weeksBack ${opts.weeksBack ?? 0}).`,
      );
    }
    return {
      startUtc: new Date(row.start_utc),
      endUtc: new Date(row.end_utc),
    };
  }

  // Settle the most recently ENDED challenge week (weeksBack: 1): pay the
  // week's top-10 the union of every pool-unlocked stage's rank rewards,
  // exactly once. Enumerator only — @InjectManager (plain read context, NO
  // transaction at this level, mirroring matureDueCommissions): each winner
  // settles in their OWN short transaction via settleChallengeWinner.
  @InjectManager()
  async settleChallengeWeek(
    deps: SettleDeps,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    weekStartIso: string;
    settled: boolean;
    winners: SettledWinner[];
  }> {
    const settings = await this.challengeSettings(sharedContext);
    const week = {
      timezone: settings.timezone,
      resetDay: settings.reset_day,
      resetHour: settings.reset_hour,
      weeksBack: 1,
    };
    const { startUtc, endUtc } = await this.challengeWeekBounds(
      week,
      sharedContext,
    );
    const weekStartIso = startUtc.toISOString();

    // Hourly self-gate, PER WINNER (spec §Scheduling): customers who already
    // hold payout rows for this week are skipped before any transaction opens.
    // Deliberately NOT a whole-week early return — a crash mid-batch leaves
    // some winners paid and some not, and a whole-week gate would lock the
    // unpaid remainder out forever. Racy by itself; the in-transaction
    // lock+check in settleChallengeWinner is the real guard.
    const existingRows = await this.listChallengePayouts(
      { week_start: startUtc },
      { select: ['customer_id', 'snapshot'], take: 1000 },
    );
    const settledCustomers = new Set(existingRows.map((r) => r.customer_id));
    // Every row of a week carries the SAME base snapshot (one shared object
    // per settleChallengeWinner call), so row 0 is representative — this is
    // not an ordering assumption.
    const prior = existingRows[0]?.snapshot as unknown as
      SettleSnapshot | undefined;

    // Sequential, not Promise.all: challengeWeekPool resolves
    // transactionManager ?? manager and listChallengeStages resolves the SAME
    // injected manager, so overlapping them is two concurrent queries on one
    // connection — this repo's "pool is probably full" shape (same rule as
    // playersOverview / enrichReferralNodes / inventoryLifecycleBuckets).
    // Two cheap reads once an hour: the parallelism bought nothing.
    const stageRows = await this.listChallengeStages(
      {},
      {
        select: ['stage_number', 'threshold_myr', 'rank_rewards'],
        take: 1000,
      },
    );
    const poolMyr = prior
      ? prior.pool_myr
      : await this.challengeWeekPool(week, sharedContext);
    const stages: SettleStage[] = stageRows.map((r) => ({
      stage_number: r.stage_number,
      threshold_myr: Number(r.threshold_myr),
      rank_rewards: (r.rank_rewards as unknown as ChallengeRankReward[]) ?? [],
    }));
    // A PARTIALLY settled week (tick 1 crashed mid-batch) replays tick 1's
    // frozen snapshot rather than recomputing. Both aggregates filter
    // `deleted_at IS NULL`, so an admin reversal landing between ticks
    // re-ranks a CLOSED window: the per-customer gate skips the already-paid,
    // everyone below shifts up, and the week pays out MORE than one prize
    // table — with nobody paid twice, so no idempotency guard fires. The pool
    // has the mirror problem: challengeWeekPool multiplies by a LIVE FX rate,
    // so stages can re-lock mid-week and strand the unpaid remainder behind
    // the empty-unlocked early return, permanently.
    // Residual, documented not fixed: each stage's rank_rewards are still read
    // live, so editing a prize table mid-week changes what the remainder gets.
    const unlocked = prior
      ? stages
          .filter((s) => prior.unlocked_stages.includes(s.stage_number))
          .sort((a, b) => a.stage_number - b.stage_number)
      : unlockedStages(stages, poolMyr);
    // The frozen table is authoritative on a re-settlement tick, so it has to
    // be resolved BEFORE the empty-unlocked gate below. `unlocked` is rebuilt by
    // filtering LIVE stages against prior.unlocked_stages, so an admin DELETING
    // an unlocked stage after a partial settlement empties it — and the gate
    // would then strand every remaining winner behind a prize table we already
    // froze and still hold. Freezing by_rank (finding 6) only helped the ticks
    // that got past this line.
    const frozenByRank =
      prior?.by_rank && Object.keys(prior.by_rank).length > 0
        ? new Map<number, RankPayout>(
            Object.entries(prior.by_rank).map(([rank, p]) => [
              Number(rank),
              { rank: Number(rank), credits: p.credits, cardIds: p.cardIds },
            ]),
          )
        : null;

    if (!frozenByRank && unlocked.length === 0) {
      return { weekStartIso, settled: false, winners: [] };
    }

    // Rank is frozen with everything else — index + 1 in this list IS the rank.
    const ranking: string[] = prior?.ranking?.length
      ? prior.ranking
      : (
          await this.challengeWeekTop({ ...week, limit: 10 }, sharedContext)
        ).map((t) => t.customer_id);
    if (ranking.length === 0) {
      return { weekStartIso, settled: false, winners: [] };
    }
    // Falling back to a live payoutByRank(unlocked) is what let a promoted
    // ladder pay an earlier week's winners; the fallback survives only for
    // snapshots written before by_rank existed.
    const byRank = frozenByRank ?? payoutByRank(unlocked);

    // Resolve card ids -> handles ONCE (spec: rank_rewards holds Card.id,
    // pull.card_id holds Card.handle — never pass ids into createPulls).
    const allCardIds = [
      ...new Set([...byRank.values()].flatMap((p) => p.cardIds)),
    ];
    const cardRows = allCardIds.length
      ? await this.listCards(
          { id: allCardIds },
          { select: ['id', 'handle'], take: allCardIds.length },
        )
      : [];
    const handleById = new Map(cardRows.map((c) => [c.id, c.handle]));

    const snapshot: SettleSnapshot = {
      pool_myr: poolMyr,
      // prior's list wins: re-deriving from `unlocked` would let a deleted
      // stage shrink the frozen record, and the NEXT tick filters against it.
      unlocked_stages: prior?.unlocked_stages ?? unlocked.map((s) => s.stage_number),
      week_end: endUtc.toISOString(),
      ranking,
      // A Map does not survive the json column — persist as a plain object and
      // rehydrate above.
      by_rank: Object.fromEntries(
        [...byRank].map(([rank, p]) => [
          String(rank),
          { rank: p.rank, credits: p.credits, cardIds: p.cardIds },
        ]),
      ),
    };
    // A deleted customer keeps their `pull` rows — the books are retained on
    // purpose — so they stay ranked, and settlement would mint real balance and
    // a real card to an account with no owner. Read once for the whole ranking,
    // outside the per-winner transactions.
    const deleted = await this.deletedCustomerIds(ranking, sharedContext);

    const winners: SettledWinner[] = [];
    for (const [i, customerId] of ranking.entries()) {
      if (settledCustomers.has(customerId)) continue; // paid on a prior tick
      if (deleted.has(customerId)) continue; // account deleted; nobody to pay
      const payout = byRank.get(i + 1);
      if (!payout || (payout.credits <= 0 && payout.cardIds.length === 0)) {
        continue; // rank pays nothing this week
      }
      // One SHORT transaction per winner — deliberately NO sharedContext
      // forwarding (matureDueCommissions invariant: one credit: advisory-lock
      // chain per transaction, never accumulated across winners).
      const settled = await this.settleChallengeWinner({
        weekStart: startUtc,
        weekEnd: endUtc,
        customerId,
        rank: i + 1,
        payout,
        handleById,
        snapshot,
        getStock: deps.getStock,
      });
      if (!settled) continue;
      winners.push(settled);
      // Committed above; the units are taken now, outside that transaction.
      await this.reserveSettledStock(settled, deps.decrementStock, weekStartIso);
      // Fired AFTER this winner's transaction committed, never inside it.
      if (!deps.onSettled) continue;
      try {
        await deps.onSettled(settled, weekStartIso);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[settleChallengeWeek] onSettled failed (payout already committed)',
          {
            customer_id: customerId,
            week_start: weekStartIso,
            error: String(err),
          },
        );
      }
    }
    return { weekStartIso, settled: winners.length > 0, winners };
  }

  // Per-winner settlement: ONE winner, ONE short transaction, ONE credit:
  // advisory lock (same keyspace as mutateCreditAtomic — xact locks are
  // reentrant, so the credits call below re-acquiring it is a no-op). The
  // whole winner settles or rolls back.
  @InjectTransactionManager()
  protected async settleChallengeWinner(
    input: {
      weekStart: Date;
      weekEnd: Date;
      customerId: string;
      rank: number;
      payout: RankPayout;
      handleById: Map<string, string>;
      snapshot: SettleSnapshot;
      getStock: (handles: string[]) => Promise<Map<string, number | null>>;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<SettledWinner | null> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const { weekStart, customerId, rank, payout } = input;
    const weekStartIso = weekStart.toISOString();

    // 1) Serialize against every money path for this customer — SAME lock key
    //    as mutateCreditAtomic.
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);

    // 2) Check under the lock, INSIDE this txn (sharedContext!) — any existing
    //    row means a concurrent run or earlier tick already settled this
    //    customer's week. The unique index stays as the last-resort backstop.
    const [already] = await this.listChallengePayouts(
      { week_start: weekStart, customer_id: customerId },
      { take: 1 },
      sharedContext,
    );
    if (already) return null;

    // 2b) ANCHOR-SHIFT guard. reset_day / reset_hour / timezone are all
    //     admin-editable (PATCH /admin/challenge/settings) and all three feed
    //     the week-anchor CTE, so an edit MOVES startUtc — and every key above
    //     (payout rows, the unique index, mutateCreditAtomic's
    //     idempotencyReference) is keyed on it. Without this, the next tick
    //     computes a fresh key, finds nothing, and re-pays the same customers
    //     for an overlapping window.
    //     This is a true INTERVAL-OVERLAP test, not a distance window:
    //     consecutive weeks are exactly contiguous (week N's end_utc IS week
    //     N+1's start_utc, DST included), while a UTC week is 6d23h / 7d /
    //     7d1h long — so no distance constant can separate a legitimate
    //     neighbour from a shifted duplicate. Overlap ⟺ stored.week_start <
    //     this end AND stored.week_end > this start: the previous week ends
    //     exactly at this start and the next begins exactly at this end, so
    //     neither is ever blocked. A shift of >= 7 days produces a DISJOINT
    //     window — paying that is correct, not a re-pay.
    //     By design, and NOT a bug: moving the anchor EARLIER also blocks
    //     the FOLLOWING week for anyone already paid, because that window
    //     still overlaps the paid one by up to 6 days and paying it would
    //     double-pay those days. It self-heals a week later, once the windows
    //     no longer overlap.
    //     The week_start lower bound is index bait for IDX_challenge_payout_week
    //     (there is no customer_id-leading index): an overlapping stored window
    //     has week_end > this start, and week_start = week_end − (7d ± 1h).
    //     COALESCE covers rows written before week_end was snapshotted.
    const [overlap] = await em.execute<{ one: number }[]>(
      `SELECT 1 AS one FROM challenge_payout
         WHERE customer_id = ? AND deleted_at IS NULL
           AND week_start > ?::timestamptz - interval '8 days'
           AND week_start < ?::timestamptz
           AND COALESCE((snapshot->>'week_end')::timestamptz,
                        week_start + interval '7 days') > ?::timestamptz
         LIMIT 1`,
      [customerId, weekStartIso, input.weekEnd.toISOString(), weekStartIso],
    );
    if (overlap) return null;

    const rows: {
      week_start: Date;
      customer_id: string;
      rank: number;
      kind: 'credits' | 'card';
      card_id: string;
      credits: number;
      credit_transaction_id: string | null;
      pull_id: string | null;
      status: 'granted' | 'skipped_no_stock';
      snapshot: Record<string, unknown>;
    }[] = [];

    // 3a) Credits — one ledger mutation for the summed amount.
    let creditTxnId: string | null = null;
    if (payout.credits > 0) {
      const { id, replayed } = await this.mutateCreditAtomic(
        {
          customerId,
          amount: payout.credits,
          reason: 'reward_credit',
          idempotencyReference: `challenge:${weekStartIso}:${customerId}`,
        },
        sharedContext,
      );
      creditTxnId = id;
      rows.push({
        week_start: weekStart,
        customer_id: customerId,
        rank,
        kind: 'credits',
        card_id: '',
        credits: payout.credits,
        credit_transaction_id: creditTxnId,
        pull_id: null,
        status: 'granted',
        // replayed = the ledger recognised this idempotencyReference and did
        // NOT move money. The row still says 'granted' (the grant IS this
        // reference), so record the distinction rather than discarding it.
        snapshot: { ...input.snapshot, credits_replayed: replayed },
      });
    }

    // 3b) Cards — dedupe ids into (id, qty); resolve handle; stock-gate; mint
    //     qty pulls or record skipped_no_stock (spec: no credit substitution).
    const qtyById = new Map<string, number>();
    for (const id of payout.cardIds) {
      qtyById.set(id, (qtyById.get(id) ?? 0) + 1);
    }
    const cardHandles: string[] = [];
    let cardCount = 0; // pulls minted, NOT distinct handles (qty can exceed 1)
    const skippedCardIds: string[] = [];
    const reservations: SettledWinner['reservations'] = [];
    const handles = [...qtyById.keys()]
      .map((id) => input.handleById.get(id))
      .filter((h): h is string => Boolean(h));
    const stockByHandle = handles.length
      ? await input.getStock(handles)
      : new Map<string, number | null>();

    for (const [cardId, qty] of qtyById) {
      const handle = input.handleById.get(cardId);
      const stock = handle ? stockByHandle.get(handle) : undefined;
      // In stock: tracked with >= qty available, or untracked (null). An
      // unresolvable id (deleted card) or absent stock row = skipped.
      const inStock =
        Boolean(handle) &&
        stockByHandle.has(handle!) &&
        (stock === null || (stock !== undefined && stock >= qty));

      // qty copies = ONE createPulls call (one round-trip); every minted id is
      // kept — the row's scalar pull_id can only hold the first.
      let pullIds: string[] = [];
      if (inStock) {
        // The gate above is kept on purpose — an out-of-stock prize becoming a
        // manual-fulfilment item is a product decision the job logs for an
        // operator — but a gate that never decrements is the read-then-check
        // race decrement-card-stock.ts:24-28 exists to avoid.
        //
        // The TAKE itself does not belong in this transaction. adjustInventory
        // is Medusa's inventory module on its own connection and commits
        // independently, so it cannot roll back with us: called from in here, a
        // later throw rolled the payout back while the take stood, and the next
        // hourly tick took the units again. reserveSettledStock runs it after
        // this transaction commits — see there for why the race stays closed.
        const minted = await this.createPulls(
          Array.from({ length: qty }, () => ({
            customer_id: customerId,
            pack_id: challengePackId(weekStartIso),
            card_id: handle!,
            order_id: null,
            rolled_at: new Date(),
            source: 'reward' as const,
            // Minted UNRESERVED; flipped only once a unit is really taken.
            // Buyback restores flagged pulls only, so false is the safe
            // default — giving back a unit that was never taken would mint a
            // phantom one (decrement-card-stock.ts:52-56).
            stock_earmarked: false,
          })),
          sharedContext,
        );
        pullIds = minted.map((p) => p.id);
        cardCount += pullIds.length;
        cardHandles.push(handle!);
        reservations.push({ handle: handle!, qty, pullIds });
      } else {
        skippedCardIds.push(cardId);
      }
      rows.push({
        week_start: weekStart,
        customer_id: customerId,
        rank,
        kind: 'card',
        card_id: cardId,
        credits: 0,
        credit_transaction_id: null,
        pull_id: pullIds[0] ?? null, // primary; full set in snapshot.pull_ids
        status: inStock ? 'granted' : 'skipped_no_stock',
        // pull_ids always present (empty on skip) so the audit trail is
        // queryable without a key-exists check.
        snapshot: { ...input.snapshot, qty, pull_ids: pullIds },
      });
    }

    if (rows.length === 0) return null;

    // 3c) WP ledger row (POLYCARD-BACK §5, Plan 060) — one row per settled
    // winner, not per card. Same ref_id as the 3a credit mutation so a retry
    // dedupes on recordLedgerEntry's own (type, ref_id) idempotency.
    // vaultDelta stays null (WP is a straight reward credit like TP, not a
    // vault-liability move). `stage` has no single source — RankPayout is
    // already a union of every unlocked stage's rewards (challenge-settle.ts
    // payoutByRank) — so this reports the highest stage unlocked that week,
    // the frontier the payout reflects; SettleSnapshot carries no per-card
    // FMV, so `value` stays 0 rather than threading new data through the job.
    await this.recordLedgerEntry(
      {
        type: 'WP',
        customerId,
        refId: `challenge:${weekStartIso}:${customerId}`,
        walletDelta: payout.credits,
        vaultDelta: null,
        payload: {
          type: 'WP',
          period: weekStartIso,
          // A winner implies >=1 unlocked stage, so the `: 0` branch is
          // defensive dead code — guards Math.max(...[]) === -Infinity.
          stage: input.snapshot.unlocked_stages.length
            ? Math.max(...input.snapshot.unlocked_stages)
            : 0,
          rank,
          sku: cardHandles[0] ?? null,
          value: 0,
        },
      },
      sharedContext,
    );

    // 4) The settled-week record — generated create (writes raw_credits).
    await this.createChallengePayouts(rows, sharedContext);

    return {
      customerId,
      rank,
      credits: payout.credits,
      cardHandles,
      cardCount,
      skippedCardIds,
      reservations,
    };
  }

  /**
   * Take the inventory units for a winner whose payout has COMMITTED.
   *
   * Deliberately outside settleChallengeWinner's transaction. adjustInventory
   * belongs to Medusa's inventory module and commits on its own connection, so
   * it cannot roll back with ours. Called from inside, a throw after it — a
   * duplicate-payout constraint, the ledger write, a dropped connection — rolled
   * the payout back while the take stood. And because the re-entry gate is per
   * CUSTOMER (settledCustomers, built from payout rows), the winner was then
   * absent from it, so the next hourly tick re-settled them and took the units
   * AGAIN, every hour for the ~168 ticks weeksBack:1 keeps the week in scope.
   *
   * Post-commit the winner is in settledCustomers for good, so this runs at
   * most once per winner. The read-then-check race the take was added for stays
   * closed: the winner loop is sequential and awaits, so the next winner's
   * getStock read sees this take.
   *
   * Failures are logged and bounded, never thrown — the payout is already
   * committed and must not be undone over a counter. Both directions are
   * conservative: a failed take leaves the pulls unflagged, so buyback can
   * never restore a unit that was not taken.
   */
  private async reserveSettledStock(
    winner: SettledWinner,
    decrementStock:
      | ((handle: string, qty: number) => Promise<boolean>)
      | undefined,
    weekStartIso: string,
  ): Promise<void> {
    if (!decrementStock) return;
    for (const r of winner.reservations) {
      try {
        // false = untracked product: nothing counted, so nothing to flag.
        if (!(await decrementStock(r.handle, r.qty))) continue;
        if (r.pullIds.length === 0) continue;
        await this.updatePulls({
          selector: { id: r.pullIds },
          data: { stock_earmarked: true },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[settleChallengeWeek] stock take failed AFTER the payout committed — counter reads high, prize already granted',
          {
            customer_id: winner.customerId,
            week_start: weekStartIso,
            handle: r.handle,
            qty: r.qty,
            error: String(err),
          },
        );
      }
    }
  }

  // One-shot backfill for the recorded-pull-value follow-up (spec 2026-07-19
  // Iteration 3): stamp recorded_value_usd on pre-existing rows from the
  // CURRENT card values — the same expression the aggregates' COALESCE
  // fallback computes, so backfilling is observation-neutral at run time and
  // only pins the value against FUTURE price syncs. Reward and free-welcome
  // pulls stay null (they are excluded from every pulled-value board, and the
  // aggregates' COALESCE fallback would put a stamped value straight back on
  // one). raw_ twin written alongside so the ORM's bigNumber hydration
  // matches workflow-stamped rows. Idempotent
  // (IS NULL guard). Run via src/scripts/backfill-recorded-pull-value.ts.
  //
  // Chunked so a large historical pull table isn't pinned under one long
  // UPDATE competing with live pack-open/buyback writes. Each batch is its own
  // statement (autocommit when the method runs outside a transaction, as the
  // medusa-exec script does), so row locks release between chunks. The batch
  // CTE JOINs card, so it only selects rows that WILL update (missing/deleted-
  // card pulls stay NULL, same as the aggregates' fallback); every selected
  // row flips non-null, so the loop makes progress and stops on a short batch.
  // A mid-run crash resumes on re-run (each batch independently IS-NULL-guarded).
  @InjectManager()
  async backfillRecordedPullValues(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<number> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const BATCH = 5_000;
    let total = 0;
    for (;;) {
      const rows = await em.execute<unknown[]>(
        'WITH batch AS ( ' +
          '  SELECT pu.id FROM pull pu ' +
          '    JOIN card c ON c.handle = pu.card_id AND c.deleted_at IS NULL ' +
          "   WHERE pu.recorded_value_usd IS NULL AND pu.source = 'pack' " +
          '   LIMIT ? ' +
          ') ' +
          'UPDATE pull pu ' +
          '   SET recorded_value_usd = ' +
          LIVE_VALUE_USD_SQL +
          ', ' +
          '       raw_recorded_value_usd = jsonb_build_object(' +
          "'value', (" +
          LIVE_VALUE_USD_SQL +
          ")::text, 'precision', ?) " +
          '  FROM card c, batch b ' +
          ' WHERE pu.id = b.id ' +
          '   AND c.handle = pu.card_id AND c.deleted_at IS NULL ' +
          ' RETURNING 1',
        [
          BATCH,
          DEFAULT_MARKET_MULTIPLIER,
          DEFAULT_MARKET_MULTIPLIER,
          BIG_NUMBER_RAW_PRECISION,
        ],
      );
      total += rows.length;
      if (rows.length < BATCH) break;
    }
    return total;
  }

  // Challenge singleton read — first row or the §4.1 defaults (never 404s).
  @InjectManager()
  async challengeSettings(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<ChallengeSettingsView> {
    const [row] = await this.listChallengeSettings(
      {},
      { take: 1 },
      sharedContext,
    );
    return {
      cadence: row?.cadence ?? 'fixed_weekly',
      timezone: row?.timezone ?? 'Asia/Kuala_Lumpur',
      reset_day: row ? Number(row.reset_day) : 1,
      reset_hour: row ? Number(row.reset_hour) : 0,
    };
  }

  // Audited singleton patch (create-on-first-edit; CHECK id='global' keeps the
  // create race-safe).
  @InjectTransactionManager()
  async editChallengeSettings(
    input: {
      patch: ChallengeSettingsPatch;
      adminId: string;
      reason: string;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<ChallengeSettingsView> {
    const [row] = await this.listChallengeSettings(
      {},
      { take: 1 },
      sharedContext,
    );
    const before: ChallengeSettingsView = {
      cadence: row?.cadence ?? 'fixed_weekly',
      timezone: row?.timezone ?? 'Asia/Kuala_Lumpur',
      reset_day: row ? Number(row.reset_day) : 1,
      reset_hour: row ? Number(row.reset_hour) : 0,
    };
    const after: ChallengeSettingsView = {
      cadence: input.patch.cadence ?? before.cadence,
      timezone: input.patch.timezone ?? before.timezone,
      reset_day: input.patch.reset_day ?? before.reset_day,
      reset_hour: input.patch.reset_hour ?? before.reset_hour,
    };
    const data = after;
    if (row) {
      await this.updateChallengeSettings(
        { selector: { id: row.id }, data },
        sharedContext,
      );
    } else {
      // First-edit create. payout is retired (never patched here), but the
      // model's payout_card_ids json column is non-nullable with no ORM-level
      // default, so the insert must seed its cold default []. payout_credits
      // has model .default(0). Same json double-cast as rank_rewards.
      await this.createChallengeSettings(
        [
          {
            id: 'global',
            ...data,
            payout_card_ids: [] as unknown as Record<string, unknown>,
          },
        ],
        sharedContext,
      );
    }
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'challenge_settings',
          entity_id: row?.id ?? 'global',
          action: 'edit',
          // The `before`/`after` audit json columns type as
          // Record<string, unknown> | null, and ChallengeSettingsView (a named
          // interface) doesn't structurally satisfy that directly.
          before: before as unknown as Record<string, unknown>,
          after: after as unknown as Record<string, unknown>,
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return after;
  }

  // Tier-defaults singleton read — the admin-configured RM display-price
  // range per rarity tier, {} when never edited (the admin app treats an
  // empty map as "feature off"). Never 404s.
  @InjectManager()
  async tierSettings(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<TierSettingsView> {
    const [row] = await this.listTierSettings({}, { take: 1 }, sharedContext);
    return { ranges: normalizeTierRanges(row?.ranges) };
  }

  // Audited singleton replace (same pattern as editChallengeSettings). The
  // ORM MERGES json columns on update (see avatar_frames above), so the
  // write carries EVERY rarity key explicitly — null overwrites a cleared
  // tier, otherwise removing a range could never persist. Transactional like
  // every audited write here: the settings row and its audit row commit or
  // roll back together.
  @InjectTransactionManager()
  async editTierSettings(
    input: { ranges: TierRangeMap; adminId: string; reason: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<TierSettingsView> {
    const [row] = await this.listTierSettings({}, { take: 1 }, sharedContext);
    const before: TierSettingsView = {
      ranges: normalizeTierRanges(row?.ranges),
    };
    const full = fillTierRanges(input.ranges);
    const data = { ranges: full as unknown as Record<string, unknown> };
    if (row) {
      await this.updateTierSettings(
        { selector: { id: row.id }, data },
        sharedContext,
      );
    } else {
      await this.createTierSettings([{ id: 'global', ...data }], sharedContext);
    }
    const after: TierSettingsView = {
      ranges: normalizeTierRanges(full),
    };
    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'tier_settings',
          entity_id: row?.id ?? 'global',
          action: 'edit',
          before: before as unknown as Record<string, unknown>,
          after: after as unknown as Record<string, unknown>,
          reason: input.reason,
        },
      ],
      sharedContext,
    );
    return after;
  }

  // Fold admin ranges → the 100-entry ladder, update only the CHANGED
  // vip_level rows (no-op writes for untouched levels), and write ONE audit
  // row — same pattern as editDailyRewardSettings/replaceRewardPool.
  // NOTE (2026-08-05): vouchers are OFF across the ladder — every level was
  // zeroed by Migration20260805000000 because the surface that redeems them
  // is suspended. This endpoint is the other writer of voucher_amount, and no
  // admin route mounts it today; calling it is how a voucher comes back.
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

  // Purchase Invoices (POLYCARD-BACK §3.5). display_no comes from
  // purchase_invoice_seq (a real Postgres sequence — atomic under
  // concurrency, immune to rollback) formatted "PI-00001". One
  // stock_movement 'purchase' row per line — the append-only paper trail the
  // item-detail history table reads; on-hand itself comes from card-stock.ts,
  // never this log (§3.1 authority note).
  //
  // line_total stores the RAW qty * unit_cost product, deliberately NOT
  // rounded to 2dp: purchase_invoice_line_line_total_check compares it against
  // Postgres' own exact numeric evaluation of the same expression with a
  // half-sen tolerance, and a pre-rounded total is what would sit ON that
  // boundary. unit_cost is already capped at 2dp by the route validator, so
  // the raw product is exact to ~1e-13 here.
  // Cross-invoice reversal validation (D8). Deliberately lives INSIDE the
  // create transaction: it is a read-then-write, and running it in the route
  // — a SEPARATE transaction from the write — was a real TOCTOU, not a
  // theoretical one. Two concurrent POSTs of the same -10 reversal both read a
  // full budget and both returned 201: ten units bought, twenty reversed.
  // Nothing downstream catches that (there is no unique constraint, and the
  // line CHECK only validates per-line arithmetic).
  //
  // The advisory lock serializes reversals of ONE target for the rest of this
  // transaction — same idiom as applyPackMemberDiff and the credit ledger — so
  // the loser re-reads only after the winner commits and sees the budget gone.
  // Reversals of different targets never contend.
  //
  // Matching is by exact card_handle + unit_cost, never FIFO/LIFO (operator
  // decision). The real invariant is a BUDGET, not a match: what the target
  // bought, minus everything prior reversals of that same target already took
  // back, must still cover this body. reverses_invoice_id is what makes that
  // sum knowable — it is why the column exists.
  private async assertReversalCovered(
    reversesInvoiceId: string,
    lines: { card_handle: string; qty: number; unit_cost: number }[],
    sharedContext: Context,
  ): Promise<void> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `purchase-invoice-reversal:${reversesInvoiceId}`,
    ]);

    // Integer sen, not a float compare: a numeric round-trip ("150.0000") and
    // the validator's 2dp-normalized body value must land on the same key.
    const key = (card_handle: string, unit_cost: unknown): string =>
      `${card_handle}|${toSen(unit_cost)}`;

    const [target] = await this.listPurchaseInvoices(
      { id: reversesInvoiceId },
      { take: 1 },
      sharedContext,
    );
    if (!target) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "'reverses_invoice_id' does not match an existing invoice.",
      );
    }
    // Undoing a reversal would need positive-qty lines, which the validator
    // forbids outright — so anything reaching here could only double-subtract.
    if (target.reverses_invoice_id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Invoice ${target.display_no} is itself a reversing invoice and cannot be reversed — reverse the original.`,
      );
    }

    // HAZARD for Task 4/5: this list (like every generated list) excludes
    // soft-deleted rows. A future void/delete route that soft-deletes a
    // reversing invoice would silently hand its headroom back. Unreachable
    // today — nothing deletes an invoice except the compensation cascade,
    // which hard-deletes an invoice that never became visible.
    const priorReversals = await pageAll((opts) =>
      this.listPurchaseInvoices(
        { reverses_invoice_id: target.id },
        opts,
        sharedContext,
      ),
    );
    // PAGED, not a take: cap — a truncated prior-reversal list fails OPEN.
    const allLines = await pageAll((opts) =>
      this.listPurchaseInvoiceLines(
        { invoice_id: [target.id, ...priorReversals.map((r) => r.id)] },
        opts,
        sharedContext,
      ),
    );

    // Signed sum: target lines positive, every prior reversal negative, so
    // this map IS what is still un-reversed per (card_handle, unit_cost).
    const remaining = new Map<string, number>();
    for (const l of allLines) {
      const k = key(l.card_handle, l.unit_cost);
      remaining.set(k, (remaining.get(k) ?? 0) + Number(l.qty));
    }
    const onTarget = new Set(
      allLines
        .filter((l) => l.invoice_id === target.id)
        .map((l) => key(l.card_handle, l.unit_cost)),
    );

    // Fold the incoming body the same way FIRST: two lines in one body for the
    // same key must spend a single budget, not be checked twice against it.
    const requested = new Map<
      string,
      { card_handle: string; unit_cost: number; qty: number }
    >();
    for (const line of lines) {
      const k = key(line.card_handle, line.unit_cost);
      const prev = requested.get(k);
      if (prev) prev.qty += line.qty;
      else requested.set(k, { ...line });
    }

    for (const [k, want] of requested) {
      if (!onTarget.has(k)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Reversal line for '${want.card_handle}' at unit_cost ${want.unit_cost} does not match any line on invoice ${target.display_no}.`,
        );
      }
      const left = remaining.get(k) ?? 0;
      // want.qty is negative; `left` is what the target still has un-reversed.
      // One-directional by design: a target line with no reversal line is just
      // a legal partial reversal.
      if (left + want.qty < 0) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Reversing ${-want.qty} of '${want.card_handle}' at unit_cost ${want.unit_cost} exceeds the ${left} still un-reversed on invoice ${target.display_no}.`,
        );
      }
    }
  }

  @InjectTransactionManager()
  async createPurchaseInvoiceWithLines(
    input: {
      date: string;
      supplier: string;
      agent_user_id: string;
      reverses_invoice_id: string | null;
      lines: {
        card_handle: string;
        card_name: string;
        fmv_snapshot: number;
        qty: number;
        unit_cost: number;
      }[];
    },
    @MedusaContext() sharedContext: Context = {},
  ) {
    if (input.reverses_invoice_id) {
      await this.assertReversalCovered(
        input.reverses_invoice_id,
        input.lines,
        sharedContext,
      );
    }

    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const [{ n }] = await em.execute<{ n: string }[]>(
      "SELECT nextval('purchase_invoice_seq') AS n",
    );
    const display_no = `PI-${String(n).padStart(5, '0')}`;

    const [invoice] = await this.createPurchaseInvoices(
      [
        {
          display_no,
          // The model column is a dateTime — the route hands over a
          // validated ISO string, so the coercion happens exactly here.
          date: new Date(input.date),
          supplier: input.supplier,
          agent_user_id: input.agent_user_id,
          reverses_invoice_id: input.reverses_invoice_id,
        },
      ],
      sharedContext,
    );

    const lines = await this.createPurchaseInvoiceLines(
      input.lines.map((l) => ({
        invoice_id: invoice.id,
        card_handle: l.card_handle,
        card_name: l.card_name,
        fmv_snapshot: l.fmv_snapshot,
        qty: l.qty,
        unit_cost: l.unit_cost,
        line_total: l.qty * l.unit_cost,
      })),
      sharedContext,
    );

    await this.createStockMovements(
      lines.map((l) => ({
        card_handle: l.card_handle,
        kind: 'purchase' as const,
        qty: l.qty,
        ref_id: l.id,
      })),
      sharedContext,
    );

    return { ...invoice, lines };
  }

  // Compensation-only hard delete — fires ONLY from the create-purchase-invoice
  // workflow's rollback path (the inventory-adjust step failing after this
  // invoice already committed). Never reachable from a route a caller sees
  // succeed; invoices stay immutable from the operator's perspective.
  @InjectTransactionManager()
  async deletePurchaseInvoiceCascade(
    invoiceId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    // PAGED, not take: 1000. That cap was safe only because the validator's
    // MAX_LINES is 200, with nothing asserting the coupling — and this is
    // compensation code that HARD-DELETES money records, so a truncated list
    // fails open and strands orphan lines/movements behind a deleted invoice.
    const lines = await pageAll((opts) =>
      this.listPurchaseInvoiceLines(
        { invoice_id: invoiceId },
        opts,
        sharedContext,
      ),
    );
    const lineIds = lines.map((l) => l.id);
    if (lineIds.length) {
      const movements = await pageAll((opts) =>
        this.listStockMovements({ ref_id: lineIds }, opts, sharedContext),
      );
      if (movements.length) {
        await this.deleteStockMovements(
          movements.map((m) => m.id),
          sharedContext,
        );
      }
      await this.deletePurchaseInvoiceLines(lineIds, sharedContext);
    }
    await this.deletePurchaseInvoices(invoiceId, sharedContext);
  }

  // ---- Inventory stock buckets (POLYCARD-BACK §3.2) ----

  // inVault / requested / shipped read the REAL owning tables — Pull for vault
  // state, DeliveryOrderItem -> Pull -> DeliveryOrder.status for the shipping
  // pipeline (Epic 1's requested|processed|ready_to_ship|shipped|completed|
  // canceled enum) — and NEVER stock_movement. §3.1 makes that table an
  // append-only paper trail, and the purchase workflow's inventory adjustment
  // is deliberately best-effort, so a 'purchase' movement can sit against a
  // counter that never moved.
  //
  // The three buckets are CONVERGENT, NOT STRUCTURAL: nothing in the schema
  // stops one physical card from being counted twice, so callers must never
  // treat them as a partition (no `total = inVault + requested + shipped`).
  // Only ONE of the two request paths is transactional — recordRewardWithdrawal
  // (service.ts:1609) writes the order, its items and the pull flip on a single
  // sharedContext under @InjectTransactionManager(). requestDeliveryStep
  // (workflows/steps/request-delivery.ts:153) is a MANUAL-UNDO sequence with no
  // surrounding transaction, and two of its failure modes leave a vaulted pull
  // against a live requested item -> {inVault: 1, requested: 1} for one card
  // (probed on the real schema with these three queries verbatim):
  //   (i)  transitionPullStatus throws AND the undo at :157-166 also throws
  //        (logged 'UNDO FAILED ... repair manually');
  //   (ii) the step's compensation at :186-194 restores the pull to 'vaulted'
  //        BEFORE deleteDeliveryOrderItems, with no try/catch around it.
  // Left convergent DELIBERATELY (operator decision): a NOT EXISTS (live item)
  // clause on the vault query would make it structural, but it would HIDE a
  // state the system already flags for manual repair and cost a join on every
  // render. transitionDeliveryOrderStatus drives completed -> 'delivered' and
  // canceled -> back to 'vaulted'; a canceled order needs no clause of its own
  // (it is in neither IN-list, and its pulls are already back in the vault).
  //
  // `dord`, not `do`: DO is a RESERVED word in Postgres and cannot alias a
  // table even with AS (probed: syntax error at or near "do").
  // COUNT(DISTINCT p.id) rather than COUNT(*): delivery_order_item is unique
  // per (order, pull), not per pull, so one physical card could span two item
  // rows — it must still count once.
  @InjectManager()
  async inventoryLifecycleBuckets(
    handles: string[],
    @MedusaContext() sharedContext: Context = {},
  ): Promise<
    Map<string, { inVault: number; requested: number; shipped: number }>
  > {
    const out = new Map<
      string,
      { inVault: number; requested: number; shipped: number }
    >();
    if (handles.length === 0) return out;
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const ph = handles.map(() => '?').join(',');

    // Sequential — concurrent queries on the shared injected EntityManager are
    // what the pool-full failures look like (same rule as playersOverview).
    const vaulted = await em.execute<{ card_id: string; n: string }[]>(
      `SELECT card_id, COUNT(*)::bigint AS n FROM pull
         WHERE status = 'vaulted' AND deleted_at IS NULL AND card_id IN (${ph})
         GROUP BY card_id`,
      handles,
    );
    const requested = await em.execute<{ card_id: string; n: string }[]>(
      `SELECT p.card_id, COUNT(DISTINCT p.id)::bigint AS n
         FROM delivery_order_item doi
         JOIN delivery_order dord
           ON dord.id = doi.delivery_order_id AND dord.deleted_at IS NULL
         JOIN pull p ON p.id = doi.pull_id AND p.deleted_at IS NULL
        WHERE doi.deleted_at IS NULL
          AND dord.status IN ('requested','processed','ready_to_ship')
          AND p.card_id IN (${ph})
        GROUP BY p.card_id`,
      handles,
    );
    const shipped = await em.execute<{ card_id: string; n: string }[]>(
      `SELECT p.card_id, COUNT(DISTINCT p.id)::bigint AS n
         FROM delivery_order_item doi
         JOIN delivery_order dord
           ON dord.id = doi.delivery_order_id AND dord.deleted_at IS NULL
         JOIN pull p ON p.id = doi.pull_id AND p.deleted_at IS NULL
        WHERE doi.deleted_at IS NULL
          AND dord.status IN ('shipped','completed')
          AND p.card_id IN (${ph})
        GROUP BY p.card_id`,
      handles,
    );

    // Pre-seed every requested handle: callers index this map by handle, so an
    // unstocked card must read 0/0/0, never undefined.
    for (const h of handles)
      out.set(h, { inVault: 0, requested: 0, shipped: 0 });
    for (const r of vaulted) out.get(r.card_id)!.inVault = Number(r.n);
    for (const r of requested) out.get(r.card_id)!.requested = Number(r.n);
    for (const r of shipped) out.get(r.card_id)!.shipped = Number(r.n);
    return out;
  }

  // D8 item cost per handle, batched for one page of the Inventory list (never
  // per row). The averaging itself is weightedAverageCost's and ONLY its: that
  // function accumulates on an integer 1/10000-ringgit scale and rounds to sen
  // exactly once, which is what keeps 1000 @ 1.005 minus 999 @ 1.004 at 2.00
  // instead of 1.00. Nothing here re-rounds a per-handle figure.
  //
  // null, never 0, when there is no cost basis — no lines at all, a net qty of
  // 0 after a full reversal, or a negative Σcost. A handle with no purchase
  // history is not a free handle, and the two must stay distinguishable all
  // the way to the caller.
  //
  // Reads `unit_cost` (the numeric column), never the raw_unit_cost bigNumber
  // sidecar. Reversal lines carry a negative qty and subtract themselves back
  // out, so no reversal-aware branch belongs here.
  //
  // HAZARD (dormant, the twin of assertReversalCovered's): this filters on the
  // LINE's deleted_at only. Nothing soft-deletes an invoice today — the
  // compensation cascade hard-deletes — but a future void/delete route would
  // leave a voided invoice's lines still priced in here while the reversal
  // budget silently forgot them. Fix BOTH together or neither.
  @InjectManager()
  async weightedAverageCostByHandle(
    handles: string[],
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (handles.length === 0) return out;
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const ph = handles.map(() => '?').join(',');
    const rows = await em.execute<
      { card_handle: string; qty: number; unit_cost: string }[]
    >(
      `SELECT card_handle, qty, unit_cost FROM purchase_invoice_line
         WHERE deleted_at IS NULL AND card_handle IN (${ph})`,
      handles,
    );
    const byHandle = new Map<string, { qty: number; unit_cost: number }[]>();
    for (const r of rows) {
      const list = byHandle.get(r.card_handle) ?? [];
      list.push({ qty: Number(r.qty), unit_cost: Number(r.unit_cost) });
      byHandle.set(r.card_handle, list);
    }
    for (const h of handles)
      out.set(h, weightedAverageCost(byHandle.get(h) ?? []));
    return out;
  }

  // Listing-show count (§3.3): the number of places a card is currently
  // offered = distinct pack-pool membership + rank-reward slots.
  //
  // PAGED, not take: 5000 — a truncated read renders a plausible WRONG count
  // instead of an obvious error (Task 4's reasoning for invoice totals).
  // `kind: null` is provably redundant against pack_odds_kind_payout_check
  // (a row WITH a kind always has card_id NULL, so card_id IN (...) already
  // excludes reward-pool product/credit/nothing rows) but states the intent:
  // real card entries only. rank_rewards is a sparse JSON array over a handful
  // of stages — an in-memory scan, no index needed.
  @InjectManager()
  async listingCountByHandle(
    handles: string[],
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (handles.length === 0) return out;

    const packRows = await pageAll((opts) =>
      this.listPackOdds({ card_id: handles, kind: null }, opts, sharedContext),
    );
    // UQ_pack_odds_pack_card already makes (pack, card) unique among live
    // rows; the Set keeps the count right regardless of that index.
    const packsByHandle = new Map<string, Set<string>>();
    for (const o of packRows) {
      if (!o.card_id) continue;
      const set = packsByHandle.get(o.card_id) ?? new Set<string>();
      set.add(o.pack_id);
      packsByHandle.set(o.card_id, set);
    }

    const stages = await pageAll((opts) =>
      this.listChallengeStages({}, opts, sharedContext),
    );
    const ranksByHandle = new Map<string, number>();
    for (const stage of stages) {
      const rewards =
        (stage.rank_rewards as unknown as ChallengeRankReward[]) ?? [];
      for (const r of rewards) {
        if (!r.card_id) continue;
        ranksByHandle.set(r.card_id, (ranksByHandle.get(r.card_id) ?? 0) + 1);
      }
    }

    for (const h of handles) {
      out.set(
        h,
        (packsByHandle.get(h)?.size ?? 0) + (ranksByHandle.get(h) ?? 0),
      );
    }
    return out;
  }
}

export default PacksModuleService;
