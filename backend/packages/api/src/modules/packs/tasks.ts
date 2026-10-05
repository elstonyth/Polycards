// modules/packs/tasks.ts — the task system's pure half (spec 2026-08-24
// Phase B): the requirement/reward unions, their validator (admin CRUD's
// gate), and the progress evaluator. No DB — the service feeds evaluators
// the counted facts.

import { MedusaError } from '@medusajs/framework/utils';

export type TaskRequirement =
  | { type: 'checkin_days'; days: number }
  | { type: 'rip_count'; count: number; pack_id?: string | null }
  | { type: 'reach_level'; level: number }
  | { type: 'vault_count'; count: number }
  | {
      type: 'vault_pixel_count';
      count: number;
      /** A pixel_pokemon id — narrows the count to that one Pokémon.
       *  null/absent = any linked pixel card. */
      pixel_pokemon_id?: string | null;
    };

export type TaskReward =
  | { type: 'credit'; amount_myr: number }
  | { type: 'pack'; pack_id: string }
  | { type: 'card'; card_handle: string };

/** A reward as GET /store/tasks sends it: pack and card rewards also carry
 *  what they are, what they are worth (RM) and their picture, so the row can
 *  show the prize itself instead of a bare "Free rip" / "Card". null = the
 *  pack/card row is gone (the claim will fail at claim time; the admin
 *  console is where that gets flagged). Images are as stored — often
 *  storefront-relative — and null when the row has none. */
export type HubReward =
  | { type: 'credit'; amount_myr: number }
  | {
      type: 'pack';
      pack_id: string;
      pack_title: string | null;
      pack_price_myr: number | null;
      pack_image: string | null;
    }
  | {
      type: 'card';
      card_handle: string;
      card_name: string | null;
      card_grade: string | null;
      card_value_myr: number | null;
      card_image: string | null;
    };

export const TASK_KINDS = ['daily', 'weekly', 'achievement'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

// Repeating cadences (daily, weekly) only make sense for facts that reset
// with their period; lifetime ratchets (VIP level) only make sense as
// achievements — as a repeating goal, a player who already met one would
// re-claim it every period. A per-period vault_count would be rip_count
// without a pack filter, so it stays achievement-only too. Pixel pulls work
// both ways: per period they count that period's paid pulls (see PeriodFacts).
const PERIODIC_TYPES = new Set([
  'checkin_days',
  'rip_count',
  'vault_pixel_count',
]);
const TYPES_BY_KIND: Record<TaskKind, Set<string>> = {
  daily: PERIODIC_TYPES,
  weekly: PERIODIC_TYPES,
  achievement: new Set(['reach_level', 'vault_count', 'vault_pixel_count']),
};

/** The claim period a task's reward is once-per: the MYT day for a daily
 *  task, the task-week Monday for a weekly one, '' (once ever) for an
 *  achievement. It keys BOTH the task_claim unique index and the credit
 *  idempotency reference, so this one function is the whole of "how often".
 *  A daily and a weekly key read the same on a Monday; that is harmless,
 *  because every claim is also keyed by its task and a task's kind is fixed. */
export function taskPeriodKey(
  kind: TaskKind,
  at: { weekStartIso: string; dayIso: string },
): string {
  if (kind === 'daily') return at.dayIso;
  if (kind === 'weekly') return at.weekStartIso;
  return '';
}

// Sanity ceiling on a single task's credit reward — same defensive stance as
// the reward-box MAX_BOX_CREDIT_MYR cap.
export const MAX_TASK_CREDIT_MYR = 10_000;

const bad = (m: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, m);
};

const posInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

export function validateTaskRequirement(
  kind: TaskKind,
  raw: unknown,
): TaskRequirement {
  const r = (raw ?? {}) as Record<string, unknown>;
  const type = r.type as string;
  const allowed = TYPES_BY_KIND[kind];
  if (!allowed) return bad(`Unknown task kind '${String(kind)}'.`);
  if (!allowed.has(type)) {
    const whose =
      kind === 'achievement' ? "An achievement's" : `A ${kind} task's`;
    bad(
      `${whose} requirement must be one of ${[...allowed].join(', ')}; got '${String(type)}'.`,
    );
  }
  switch (type) {
    case 'checkin_days':
      if (!posInt(r.days) || (r.days as number) > 7)
        bad('checkin_days: days must be an integer 1..7.');
      // A day holds one check-in, so a daily task asking for more could
      // never complete.
      if (kind === 'daily' && r.days !== 1)
        bad('checkin_days: a daily task counts today only — days must be 1.');
      return { type, days: r.days as number };
    case 'rip_count':
      if (!posInt(r.count)) bad('rip_count: count must be a positive integer.');
      if (r.pack_id != null && typeof r.pack_id !== 'string')
        bad('rip_count: pack_id must be a pack slug string when set.');
      return {
        type,
        count: r.count as number,
        pack_id: (r.pack_id as string | undefined) ?? null,
      };
    case 'reach_level':
      if (!posInt(r.level) || (r.level as number) > 100)
        bad('reach_level: level must be an integer 1..100.');
      return { type, level: r.level as number };
    case 'vault_count':
      if (!posInt(r.count)) bad(`${type}: count must be a positive integer.`);
      return { type, count: r.count as number };
    case 'vault_pixel_count':
      if (!posInt(r.count)) bad(`${type}: count must be a positive integer.`);
      if (r.pixel_pokemon_id != null && typeof r.pixel_pokemon_id !== 'string')
        bad(
          'vault_pixel_count: pixel_pokemon_id must be a pixel Pokémon id string when set.',
        );
      return {
        type,
        count: r.count as number,
        pixel_pokemon_id: (r.pixel_pokemon_id as string | undefined) ?? null,
      };
    default:
      return bad(`Unknown requirement type '${String(type)}'.`);
  }
}

export function validateTaskReward(raw: unknown): TaskReward {
  const r = (raw ?? {}) as Record<string, unknown>;
  switch (r.type as string) {
    case 'credit': {
      const amount = r.amount_myr;
      if (
        typeof amount !== 'number' ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > MAX_TASK_CREDIT_MYR ||
        Math.abs(amount * 100 - Math.round(amount * 100)) >= 1e-6
      ) {
        bad(
          `credit: amount_myr must be 0 < RM x <= ${MAX_TASK_CREDIT_MYR} in whole sen.`,
        );
      }
      return { type: 'credit', amount_myr: amount as number };
    }
    case 'pack':
      if (typeof r.pack_id !== 'string' || !r.pack_id)
        bad('pack: pack_id (slug) is required.');
      return { type: 'pack', pack_id: r.pack_id as string };
    case 'card':
      if (typeof r.card_handle !== 'string' || !r.card_handle)
        bad('card: card_handle is required.');
      return { type: 'card', card_handle: r.card_handle as string };
    default:
      return bad(`Unknown reward type '${String(r.type)}'.`);
  }
}

/** What one customer did inside ONE period window (today MYT, or this task
 *  week). Rips and pixel pulls count PAID pack pulls only (source='pack'):
 *  free rips and reward cards never count, so a task's own prize can never
 *  feed a task. */
export interface PeriodFacts {
  checkinDays: number;
  rips: number;
  ripsByPack: Map<string, number>;
  pixelPulls: number;
  /** Per-species tallies, keyed by pixel_pokemon_id. */
  pixelPullsById: Map<string, number>;
}

/** The facts the service counts for one customer; the evaluator maps a
 *  requirement onto them. `week` is the TASK week — `taskWeekFor`, Monday
 *  00:00 MYT — not the Tuesday settlement week `referralWeekFor` returns;
 *  `day` is the MYT calendar day, which always sits inside that week. The
 *  rest are lifetime ratchets for achievements. */
export interface TaskFacts {
  day: PeriodFacts;
  week: PeriodFacts;
  vipLevel: number;
  vaultCount: number;
  /** Lifetime, every source — the achievement count. */
  vaultPixelCount: number;
  /** Per-species tallies, keyed by pixel_pokemon_id. */
  vaultPixelCountById: Map<string, number>;
}

/** Is this definition inside its scheduled run window at `at`?
 *  Both bounds are optional: null start = "already running", null end =
 *  "runs until retired". `active` is a separate manual kill switch. */
export function taskIsLive(
  def: { starts_at?: Date | string | null; ends_at?: Date | string | null },
  at: Date,
): boolean {
  const t = at.getTime();
  if (def.starts_at && new Date(def.starts_at).getTime() > t) return false;
  if (def.ends_at && new Date(def.ends_at).getTime() <= t) return false;
  return true;
}

export function taskProgress(
  kind: TaskKind,
  requirement: TaskRequirement,
  facts: TaskFacts,
): { current: number; target: number; completed: boolean } {
  // The window a repeating task is measured in. Achievements only use the
  // lifetime fields below, never this.
  const period = kind === 'daily' ? facts.day : facts.week;
  let current = 0;
  let target = 0;
  switch (requirement.type) {
    case 'checkin_days':
      current = period.checkinDays;
      target = requirement.days;
      break;
    case 'rip_count':
      current = requirement.pack_id
        ? (period.ripsByPack.get(requirement.pack_id) ?? 0)
        : period.rips;
      target = requirement.count;
      break;
    case 'reach_level':
      current = facts.vipLevel;
      target = requirement.level;
      break;
    case 'vault_count':
      current = facts.vaultCount;
      target = requirement.count;
      break;
    case 'vault_pixel_count': {
      const [total, byId] =
        kind === 'achievement'
          ? [facts.vaultPixelCount, facts.vaultPixelCountById]
          : [period.pixelPulls, period.pixelPullsById];
      current = requirement.pixel_pokemon_id
        ? (byId.get(requirement.pixel_pokemon_id) ?? 0)
        : total;
      target = requirement.count;
      break;
    }
    default:
      // An unrecognised requirement (a row written before a union change, or
      // straight into the DB) leaves target at 0 — and `0 >= 0` would read as
      // COMPLETE, handing every customer a free claim. Fail closed: the
      // `target > 0` guard below is what makes that impossible (bug review
      // 2026-08-25).
      break;
  }
  return {
    current: Math.min(current, target),
    target,
    // target > 0 is load-bearing, not decorative — see the default branch.
    completed: target > 0 && current >= target,
  };
}
