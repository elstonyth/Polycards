// The /task hub's pure half: how a hub payload becomes the three tabs, the
// check-in track, and the row order. Split out of TaskHubClient so the rules
// that decide WHAT a player sees (and in which order) are unit-tested without
// rendering anything.
import { rm, rmAuto, rmNbsp } from '@/lib/format';
import type { TaskEntry, TaskHub } from '@/lib/data/schemas';

export const CREDIT_ART = '/images/task/credits-coins.webp';

// Built from its code point: a literal U+00A0 (or its escape) in source has
// already been flattened back into a plain space once, silently.
const NBSP = String.fromCharCode(0xa0);

const CREDIT_LABEL = 'Bonus credit';

const REWARD_LABEL: Record<string, string> = {
  credit: CREDIT_LABEL,
  pack: 'Free rip',
  card: 'Card',
};

/** Every reward reads "what · worth": the player sees what a task pays before
 *  they claim it. `value` is null when the backend could not price it (a
 *  deleted pack/card, or a backend that predates the field). */
export function rewardLabel(reward: TaskEntry['reward']): {
  name: string;
  value: number | null;
} {
  if (reward.type === 'credit' && typeof reward.amount_myr === 'number') {
    return {
      name: `${rm(reward.amount_myr)} bonus credit`,
      value: reward.amount_myr,
    };
  }
  // A free rip names its pack; the slug is the fallback (a backend that
  // predates pack_title, or a pack since deleted) — never a bare "Free rip".
  if (reward.type === 'pack' && (reward.pack_title || reward.pack_id)) {
    return {
      name: `Free rip · ${reward.pack_title || reward.pack_id}`,
      value: reward.pack_price_myr ?? null,
    };
  }
  if (reward.type === 'card' && reward.card_name) {
    return {
      // Non-breaking space: "PSA 10" must not wrap as "PSA / 10".
      name: reward.card_grade
        ? `${reward.card_name} · ${reward.card_grade.replace(/ /g, NBSP)}`
        : reward.card_name,
      value: reward.card_value_myr ?? null,
    };
  }
  return { name: REWARD_LABEL[reward.type] ?? 'Reward', value: null };
}

/** The prize's name on the ticket stub: the art's badge already shows the
 *  worth, so credit just says what it is. */
export const stubName = (reward: TaskEntry['reward']): string =>
  reward.type === 'credit' ? CREDIT_LABEL : rewardLabel(reward).name;

/** The line shown once a claim lands (spec 2026-10-15 §3): bonus credit is
 *  for packs only; a prize card ships for a fee or sells back withdrawable. A
 *  free rip normally hands the player to the slot instead; one that could not
 *  (no claim id) waits in the free-rip list at the top of /task. */
export function claimNotice(
  reward: TaskEntry['reward'],
  tickets?: number,
): string {
  const extra =
    typeof tickets === 'number' && Number.isFinite(tickets) && tickets > 0
      ? ` + ${tickets} Lucky Draw ${tickets === 1 ? 'ticket' : 'tickets'}`
      : '';
  return rewardNotice(reward) + extra;
}

function rewardNotice(reward: TaskEntry['reward']): string {
  if (reward.type === 'credit') {
    const amount = reward.amount_myr;
    const what =
      typeof amount === 'number' && Number.isFinite(amount) && amount > 0
        ? `${rmNbsp(amount)} bonus credit`
        : 'Bonus credit';
    return `${what} added. Use it on packs — it can’t be withdrawn.`;
  }
  if (reward.type === 'pack')
    return 'Free rip added — spin it from the top of this page.';
  return 'Card added to your Vault. Ship it (delivery fee applies) or sell it back.';
}

/** The picture of the prize: the card's slab, the pack's shot, or the credit
 *  coins. null = nothing to show (a gone pack/card) — the tile falls back to
 *  an icon rather than a broken image. */
export function rewardArt(reward: TaskEntry['reward']): string | null {
  if (reward.type === 'credit') return CREDIT_ART;
  if (reward.type === 'pack') return reward.pack_image ?? null;
  if (reward.type === 'card') return reward.card_image ?? null;
  return null;
}

export const isClaimable = (t: TaskEntry): boolean =>
  t.progress.completed && !t.claimed;

export type ChallengeKind =
  'rip' | 'pull' | 'vault' | 'level' | 'checkin' | 'topup' | 'other';

export interface Challenge {
  kind: ChallengeKind;
  verb: string;
  amount: string;
  /** What the goal names, pictured: its pack or Pokémon. null = none named,
   *  or a backend that predates the art — the row shows the kind's icon. */
  art: string | null;
  /** That pack's or Pokémon's name — the picture's alt text. */
  subject: string | null;
}

const GOALS: Record<
  string,
  { kind: ChallengeKind; verb: string; one: string; many: string }
> = {
  rip_count: { kind: 'rip', verb: 'RIP', one: 'rip', many: 'rips' },
  vault_pixel_count: { kind: 'pull', verb: 'PULL', one: 'pull', many: 'pulls' },
  vault_count: { kind: 'vault', verb: 'COLLECT', one: 'card', many: 'cards' },
  reach_level: { kind: 'level', verb: 'REACH', one: 'level', many: 'levels' },
  checkin_days: {
    kind: 'checkin',
    verb: 'CHECK IN',
    one: 'check-in',
    many: 'check-ins',
  },
  topup_myr: { kind: 'topup', verb: 'TOP UP', one: '', many: '' },
};

const goalOf = (t: TaskEntry) =>
  Object.hasOwn(GOALS, t.requirement.type) ? GOALS[t.requirement.type] : null;

/** The challenge side of a row, read the way the boss sketched it: a verb, a
 *  picture of what to do it to, and how many — "RIP [Bronze Pack] ×10". An
 *  unknown type (a backend newer than this page) falls back to a neutral GOAL
 *  with no picture — never a crash. */
export function challengeOf(t: TaskEntry): Challenge {
  const g = goalOf(t);
  const { target } = t.progress;
  if (!g)
    return {
      kind: 'other',
      verb: 'GOAL',
      amount: String(target),
      art: null,
      subject: null,
    };
  const q = t.requirement;
  return {
    kind: g.kind,
    verb: g.verb,
    amount:
      g.kind === 'level'
        ? `LV ${target}`
        : g.kind === 'topup'
          ? rmAuto(target)
          : `×${target}`,
    art:
      (g.kind === 'rip'
        ? q.pack_image
        : g.kind === 'pull'
          ? q.pokemon_image
          : null) || null,
    subject:
      (g.kind === 'rip'
        ? q.pack_title
        : g.kind === 'pull'
          ? q.pokemon_name
          : null) ?? null,
  };
}

/** How far along a task is, clamped to its goal: the bar's fill (rounded
 *  DOWN, so a bar is never full before the goal is), whether it draws one
 *  pip per step (a count of 10 or fewer — never money, where RM 9.75 of
 *  RM 10 would light every pip), the count beside it ("3"/"10"; a money
 *  goal shows only the RM in, its target being the row's headline — a
 *  "RM 999.99/RM 1,000" squeezed the bar to nothing on a phone), and the
 *  bar's screen-reader text ("3 of 10", "RM 40.50 of RM 100"). */
export function progressOf(t: TaskEntry): {
  done: number;
  pct: number;
  pips: boolean;
  count: { done: string; of: string | null };
  label: string;
} {
  const { current, target } = t.progress;
  const done = Math.max(0, Math.min(current, target));
  const money = goalOf(t)?.kind === 'topup';
  const fmt = money ? rmAuto : String;
  return {
    done,
    pct: target > 0 ? Math.floor((done / target) * 100) : 0,
    pips: !money && Number.isInteger(target) && target > 0 && target <= 10,
    count: { done: fmt(done), of: money ? null : fmt(target) },
    label: `${fmt(done)} of ${fmt(target)}`,
  };
}

/** The line under a challenge's progress: what is left, or that it is done. */
export function challengeStatus(t: TaskEntry): string {
  if (t.claimed) return 'Prize claimed';
  if (t.progress.completed) return 'Complete — your prize is ready';
  // A goal of 0 is one the backend could not read (an unknown type fails
  // closed) — it can never complete, so it must not look nearly done.
  if (!(t.progress.target > 0)) return 'Not available right now';
  const g = goalOf(t);
  const gap = t.progress.target - t.progress.current;
  // Target met but not yet flagged complete by the backend.
  if (!(gap > 0)) return 'Almost there';
  if (g?.kind === 'topup')
    return `Top up ${rmAuto(gap).replace(' ', NBSP)} more`;
  const left = Math.ceil(gap);
  return g
    ? `${left} more ${left === 1 ? g.one : g.many} to go`
    : `${left} to go`;
}

/** Claimable first (that is what the player came for), then in progress,
 *  then already claimed. Stable inside each band, so the admin's sort order
 *  still holds. */
export function orderForDisplay(tasks: readonly TaskEntry[]): TaskEntry[] {
  const band = (t: TaskEntry) => (isClaimable(t) ? 0 : t.claimed ? 2 : 1);
  return tasks
    .map((t, i) => [t, i] as const)
    .sort(([a, ai], [b, bi]) => band(a) - band(b) || ai - bi)
    .map(([t]) => t);
}

/** A weekly "check in on N days" task IS a check-in milestone: it renders on
 *  slot N of the track, not as a row (no duplicates). Daily check-in tasks
 *  ("check in today") stay rows — they belong to today, not to a slot. */
const isMilestone = (t: TaskEntry): boolean =>
  t.kind === 'weekly' && t.requirement.type === 'checkin_days';

export function milestoneDay(t: TaskEntry): number {
  const days = Number((t.requirement as { days?: unknown }).days);
  return Number.isInteger(days) && days >= 1 && days <= 7 ? days : 7;
}

export interface HubTabs {
  daily: TaskEntry[];
  weekly: TaskEntry[];
  achievements: TaskEntry[];
  /** Check-in milestones by slot (1..7); several tasks may share a day. */
  milestones: Map<number, TaskEntry[]>;
}

export function splitHub(tasks: readonly TaskEntry[]): HubTabs {
  const milestones = new Map<number, TaskEntry[]>();
  const out: HubTabs = { daily: [], weekly: [], achievements: [], milestones };
  for (const t of tasks) {
    if (isMilestone(t)) {
      const day = milestoneDay(t);
      milestones.set(day, [...(milestones.get(day) ?? []), t]);
    } else if (t.kind === 'daily') out.daily.push(t);
    else if (t.kind === 'weekly') out.weekly.push(t);
    else out.achievements.push(t);
  }
  out.daily = orderForDisplay(out.daily);
  out.weekly = orderForDisplay(out.weekly);
  out.achievements = orderForDisplay(out.achievements);
  return out;
}

/** Filled slots on the track. The backend's count when it sends one; a
 *  backend that predates the field still has the milestones' own progress
 *  (each IS this week's check-in count, clamped at its target), and failing
 *  that, today's tap. */
export function checkinCount(hub: TaskHub, tabs: HubTabs): number {
  if (typeof hub.checkins_this_week === 'number')
    return Math.min(7, Math.max(0, hub.checkins_this_week));
  let n = hub.checked_in_today ? 1 : 0;
  for (const list of tabs.milestones.values())
    for (const t of list) n = Math.max(n, t.progress.current);
  return Math.min(7, n);
}

/** How many claimable rewards each tab holds — the gold dot on the tab. */
export function claimableCounts(tabs: HubTabs): {
  daily: number;
  weekly: number;
  achievements: number;
} {
  const n = (list: readonly TaskEntry[]) => list.filter(isClaimable).length;
  return {
    daily: n(tabs.daily) + n([...tabs.milestones.values()].flat()),
    weekly: n(tabs.weekly),
    achievements: n(tabs.achievements),
  };
}
