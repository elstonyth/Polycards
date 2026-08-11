import { MedusaError } from '@medusajs/framework/utils';
import { MAX_VOUCHER_MYR } from './voucher-ranges';

// threshold_myr is a community-pool rung, not a payout — prod already renders
// RM 1.5M pools, so the cap only needs to reject absurd values (RM 100M).
const MAX_THRESHOLD_MYR = 100_000_000;

/** One rank's prize inside a stage. A rank may carry a card AND/OR credits;
 *  ranks absent from a stage's table pay nothing. */
export interface ChallengeRankReward {
  rank: number;
  card_id: string | null;
  credits: number;
}

export interface ChallengeStageInput {
  stage_number: number;
  threshold_myr: number;
  rank_rewards: ChallengeRankReward[];
}

export const MAX_REWARD_RANK = 10;

export interface ChallengeSettingsPatch {
  cadence?: string;
  timezone?: string;
  reset_day?: number;
  reset_hour?: number;
}

export interface ChallengeSettingsView {
  cadence: string;
  timezone: string;
  reset_day: number;
  reset_hour: number;
}

const bad = (m: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, m);
};

// Per-rank prize table: ranks 1..MAX_REWARD_RANK, unique, sparse (an omitted
// rank simply pays nothing), credits >= 0, card_id a non-empty id or null.
// Card EXISTENCE is a service-level DB check, not here.
function validateRankRewards(
  raw: unknown,
  label: string,
): ChallengeRankReward[] {
  if (!Array.isArray(raw)) bad(`${label} must be an array of rank rewards.`);
  const seen = new Set<number>();
  const out: ChallengeRankReward[] = [];
  for (const row of raw as unknown[]) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      bad(`${label}: each entry must be an object.`);
    const r = row as Record<string, unknown>;
    const rank = r.rank;
    if (
      typeof rank !== 'number' ||
      !Number.isInteger(rank) ||
      rank < 1 ||
      rank > MAX_REWARD_RANK
    )
      bad(
        `${label}: rank must be an integer 1–${MAX_REWARD_RANK}; got ${String(rank)}.`,
      );
    if (seen.has(rank as number)) bad(`${label}: duplicate rank ${String(rank)}.`);
    seen.add(rank as number);
    // Per-rank credits mint real balance, so they share the voucher ceiling
    // (plan 044): a fat-fingered figure or a stolen admin token cannot
    // configure an unbounded payout.
    const credits = r.credits ?? 0;
    if (
      typeof credits !== 'number' ||
      !Number.isFinite(credits) ||
      credits < 0 ||
      credits > MAX_VOUCHER_MYR
    )
      bad(
        `${label}: rank ${String(rank)} credits must be between 0 and ${MAX_VOUCHER_MYR}.`,
      );
    const cardId = r.card_id ?? null;
    if (
      cardId !== null &&
      (typeof cardId !== 'string' || cardId.trim().length === 0)
    )
      bad(
        `${label}: rank ${String(rank)} card_id must be a non-empty card id or null.`,
      );
    out.push({
      rank: rank as number,
      card_id: cardId as string | null,
      credits: credits as number,
    });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// Stages: contiguous from 1, strictly-increasing thresholds, non-negative
// per-rank reward tables. Empty list is VALID (challenge disabled). Card
// EXISTENCE is a service-level DB check, not here.
/**
 * Ceiling on the number of stages in one ladder, and on a single rank's TOTAL
 * credit once summed across all of them. Without the aggregate bound, a
 * configuration where every individual value satisfies MAX_VOUCHER_MYR can
 * still mint an effectively unbounded payout.
 */
export const MAX_STAGES = 100;
export const MAX_AGGREGATE_RANK_CREDITS_MYR = 10_000;

export function validateChallengeStages(raw: unknown): ChallengeStageInput[] {
  const body = (raw as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(body)) bad('stages must be an array.');
  const rows = body as unknown[];
  const out: ChallengeStageInput[] = [];
  let prevThreshold = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] ?? {}) as Record<string, unknown>;
    const n = i + 1;
    if (r.stage_number !== n)
      bad(
        `stage_number at position ${i} must be ${n} (contiguous 1..N); got ${String(r.stage_number)}.`,
      );
    const t = r.threshold_myr;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0)
      bad(`stage ${n}: threshold_myr must be >= 0.`);
    if ((t as number) > MAX_THRESHOLD_MYR)
      bad(`stage ${n}: threshold_myr must be <= ${MAX_THRESHOLD_MYR}.`);
    if (i > 0 && !((t as number) > prevThreshold))
      bad(`stage ${n}: threshold_myr must exceed stage ${n - 1}'s.`);
    prevThreshold = t as number;
    out.push({
      stage_number: n,
      threshold_myr: t as number,
      rank_rewards: validateRankRewards(
        r.rank_rewards,
        `stage ${n}: rank_rewards`,
      ),
    });
  }

  // MAX_VOUCHER_MYR bounds each rank reward PER STAGE, but payoutByRank SUMS a
  // rank's credits across every unlocked stage — so N stages at the cap multiply
  // it by N, and nothing downstream bounds the total (mutateCreditAtomic has no
  // maximum-amount guard). The per-rank cap's own comment names "a stolen admin
  // token" as its threat model, which this defeated.
  //
  // Enforced HERE, on the admin save path, and deliberately NOT inside
  // payoutByRank: throwing at settlement time would crash the hourly job
  // (jobs/settle-challenge-week.ts awaits settleChallengeWeek with no try/catch)
  // and starve the promotion step that runs after it.
  if (out.length > MAX_STAGES) {
    bad(`A ladder may have at most ${MAX_STAGES} stages; got ${out.length}.`);
  }
  const totalByRank = new Map<number, number>();
  for (const stage of out) {
    for (const rr of stage.rank_rewards) {
      totalByRank.set(rr.rank, (totalByRank.get(rr.rank) ?? 0) + rr.credits);
    }
  }
  for (const [rank, total] of totalByRank) {
    if (total > MAX_AGGREGATE_RANK_CREDITS_MYR) {
      bad(
        `rank ${rank} would be paid RM ${total} summed across unlocked stages, ` +
          `above the RM ${MAX_AGGREGATE_RANK_CREDITS_MYR} ceiling. ` +
          'Reduce a stage reward or the stage count.',
      );
    }
  }
  return out;
}

// Settings: shape/range checks only. Only present fields are validated +
// returned. payout fields retired — stages are the prize pool, see
// store/challenge/route.ts.
export function validateChallengeSettingsPatch(
  raw: unknown,
): ChallengeSettingsPatch {
  const patch = (raw as { patch?: unknown } | null)?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    bad('patch must be an object.');
  const b = patch as Record<string, unknown>;
  const out: ChallengeSettingsPatch = {};

  if (b.cadence !== undefined) {
    if (b.cadence !== 'fixed_weekly') bad("cadence must be 'fixed_weekly'.");
    out.cadence = 'fixed_weekly';
  }
  if (b.timezone !== undefined) {
    const zones = (
      Intl as typeof Intl & { supportedValuesOf(key: string): string[] }
    ).supportedValuesOf('timeZone');
    if (typeof b.timezone !== 'string' || !zones.includes(b.timezone))
      bad('timezone must be a valid IANA time zone.');
    out.timezone = b.timezone as string;
  }
  if (b.reset_day !== undefined) {
    const v = b.reset_day;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 6)
      bad('reset_day must be an integer 0–6.');
    out.reset_day = v as number;
  }
  if (b.reset_hour !== undefined) {
    const v = b.reset_hour;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 23)
      bad('reset_hour must be an integer 0–23.');
    out.reset_hour = v as number;
  }
  if (Object.keys(out).length === 0) bad('No valid settings to update.');
  return out;
}
