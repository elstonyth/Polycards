// The /task hub's pure half: how a hub payload becomes the three tabs, the
// check-in track, and the row order. Split out of TaskHubClient so the rules
// that decide WHAT a player sees (and in which order) are unit-tested without
// rendering anything.
import { rm } from '@/lib/format';
import type { TaskEntry, TaskHub } from '@/lib/data/schemas';

export const CREDIT_ART = '/images/task/credits-coins.webp';

const REWARD_LABEL: Record<string, string> = {
  credit: 'Credit',
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
      name: `${rm(reward.amount_myr)} credit`,
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
        ? `${reward.card_name} · ${reward.card_grade.replace(/ /g, ' ')}`
        : reward.card_name,
      value: reward.card_value_myr ?? null,
    };
  }
  return { name: REWARD_LABEL[reward.type] ?? 'Reward', value: null };
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
