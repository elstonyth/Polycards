// The Tasks board's pure half: which week a task belongs to, the name a rule
// writes for itself, and where an older hand-typed name parts from its rule.
// The name check exists because customers are paid by the rule while staff read
// the title, and the two can drift apart.
import type { AdminTaskDefinition } from '../../lib/admin-rest';

const MYT_MS = 8 * 3600_000;
const WEEK_MS = 7 * 24 * 3600_000;
const OVERRUN_MS = 2 * 3600_000;

/** Monday 00:00 Malaysia time of the week holding `at`, as an instant. Same
 *  week as the backend's taskWeekFor. */
export const weekStart = (at: number): number => {
  const d = new Date(at + MYT_MS);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return (
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - sinceMonday,
    ) - MYT_MS
  );
};

export const addWeeks = (start: number, weeks: number): number =>
  start + weeks * WEEK_MS;

const myt = (at: number, opts: Intl.DateTimeFormatOptions): string =>
  new Date(at).toLocaleDateString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    ...opts,
  });

/** "2 – 8 Nov", or "30 Nov – 6 Dec" across a month. */
export const weekLabel = (start: number): string => {
  const lastDay = start + WEEK_MS - 24 * 3600_000;
  const sameMonth =
    myt(start, { month: 'short' }) === myt(lastDay, { month: 'short' });
  const from = myt(
    start,
    sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' },
  );
  return `${from} – ${myt(lastDay, { day: 'numeric', month: 'short' })}`;
};

/** Does this task run in the week? Retired tasks are listed apart. A hand-typed
 *  end can run a little past the Monday reset (12:59 AM, say);
 *  that overrun doesn't make it part of the next week. */
export const runsInWeek = (t: AdminTaskDefinition, start: number): boolean => {
  if (!t.active) return false;
  const end = start + WEEK_MS;
  const from = t.starts_at ? new Date(t.starts_at).getTime() : start;
  const to = t.ends_at ? new Date(t.ends_at).getTime() : end;
  const overlap = Math.min(to, end) - Math.max(from, start);
  return overlap > 0 && !(from < start && overlap < OVERRUN_MS);
};

export const retiredInWeek = (
  t: AdminTaskDefinition,
  start: number,
): boolean => {
  if (t.active || !t.retired_at) return false;
  const at = new Date(t.retired_at).getTime();
  return at >= start && at < start + WEEK_MS;
};

/** The amount the goal's own type uses. Old rows can hold a key from an earlier
 *  goal, so never `days ?? count`. */
export const goalAmount = (requirement: Record<string, unknown>): number => {
  const field =
    requirement.type === 'checkin_days'
      ? requirement.days
      : requirement.type === 'reach_level'
        ? requirement.level
        : requirement.type === 'topup_myr'
          ? requirement.amount_myr
          : requirement.count;
  return Number(field ?? 0);
};

const money = (n: number): string =>
  `RM ${n.toLocaleString('en-MY', { maximumFractionDigits: 2 })}`;

/** "Bronze Pack" reads as "Bronze" in a name; "30th Celebration" stays whole. */
export const shortPack = (title: string): string =>
  title.replace(/\s+pack$/i, '');

export interface NameParts {
  kind: AdminTaskDefinition['kind'];
  reqType: string;
  n: number;
  /** The Pokémon or pack the goal names; null = any. */
  goalName: string | null;
  rewardType: string;
  /** The pack or card the reward names. */
  rewardName: string | null;
  /** RM for credit. */
  rewardAmount: number;
  tickets: number;
}

const rewardWords = (p: NameParts): string => {
  const tickets = `${p.tickets} ${p.tickets === 1 ? 'ticket' : 'tickets'}`;
  if (p.rewardType === 'tickets') return tickets;
  const main =
    p.rewardType === 'credit'
      ? `free ${money(p.rewardAmount)} bonus credit`
      : p.rewardType === 'pack'
        ? `free 1 ${shortPack(p.rewardName ?? 'pack')}`
        : `free ${p.rewardName ?? 'card'}`;
  return p.tickets > 0 ? `${main} + ${tickets}` : main;
};

/** The title a rule writes for itself. Staff never type one, so the two can't
 *  disagree. Close to how the team has been writing them by hand. */
export const taskName = (p: NameParts): string => {
  const { n, goalName } = p;
  switch (p.reqType) {
    case 'checkin_days':
      return p.kind === 'daily'
        ? 'Check in today'
        : `Check in ${n} ${n === 1 ? 'day' : 'days'} this week`;
    case 'vault_pixel_count':
      if (p.kind === 'achievement')
        return goalName ? `Vault ${n} ${goalName}` : `Vault ${n} Pokémon cards`;
      return goalName
        ? `Pull ${n} ${goalName} (Graded or Ungraded)`
        : `Pull ${n} Pokémon cards`;
    case 'rip_count':
      return `${
        goalName
          ? `Rip ${n} ${shortPack(goalName)}`
          : `Rip any ${n} ${n === 1 ? 'pack' : 'packs'}`
      }, ${rewardWords(p)}`;
    case 'topup_myr':
      return `Top up ${money(n)}, ${rewardWords(p)}`;
    case 'reach_level':
      return `Reach VIP level ${n}`;
    case 'vault_count':
      return `Vault ${n} ${n === 1 ? 'card' : 'cards'}`;
    default:
      return 'Task';
  }
};

export const namePartsOf = (t: AdminTaskDefinition): NameParts => {
  const q = t.requirement;
  const w = t.reward;
  return {
    kind: t.kind,
    reqType: String(q.type ?? ''),
    n: goalAmount(q),
    goalName: t.view?.goal_name ?? null,
    rewardType: String(w.type ?? ''),
    rewardName: t.view?.reward_name ?? null,
    rewardAmount: Number(w.amount_myr ?? 0),
    tickets: t.tickets ?? 0,
  };
};

export type NameIssue =
  /** The name says one kind of goal, the rule is another. */
  | { kind: 'goal'; says: string }
  /** The name gives a different count or amount. */
  | { kind: 'count'; says: number }
  /** The name names something, the rule counts anything. */
  | { kind: 'any'; says: string }
  /** The name doesn't mention what the rule names. */
  | { kind: 'target'; wants: string };

const GOAL_WORDS: [RegExp, string[]][] = [
  [/^check[\s-]?in/, ['checkin_days']],
  [/^(pull|collect)/, ['vault_pixel_count']],
  [/^vault/, ['vault_pixel_count', 'vault_count']],
  [/^rip/, ['rip_count']],
  [/^top\s?up/, ['topup_myr']],
  [/^reach/, ['reach_level']],
];

const FILLER = new Set(
  'rip pull collect vault any pack packs of all pokémon pokemon card cards graded or ungraded the this week x'.split(
    ' ',
  ),
);

/**
 * Reads a hand-typed title and says where it parts from the rule. New titles
 * come from taskName and always pass; this is for the rows typed before that.
 * Calibrated on titles staff have really typed (see the test).
 */
export const nameIssue = (t: AdminTaskDefinition): NameIssue | null => {
  const title = t.title.toLowerCase().trim();
  const type = String(t.requirement.type ?? '');
  const said = GOAL_WORDS.find(([word]) => word.test(title));
  if (said && !said[1].includes(type)) {
    return { kind: 'goal', says: t.title.split(/\s+/)[0] };
  }

  // Only the part before "free 1 Bronze" talks about the goal.
  const goalPart = title.split(/\b(?:free|win)\b|,\s/)[0];
  const goalName = t.view?.goal_name ?? null;
  const namedWord = goalName ? goalName.toLowerCase().split(/\s+/)[0] : null;

  // A pack can be named "30th" or "151": that number isn't the count.
  const forCount = (namedWord ? goalPart.replace(namedWord, ' ') : goalPart)
    .replace(/\brm\s?/g, '')
    .replace(/\s+/g, ' ');
  const found = forCount.match(/\b\d[\d,]*\b/);
  const says = found
    ? Number(found[0].replace(/,/g, ''))
    : type === 'rip_count' || type === 'vault_pixel_count'
      ? 1
      : null;
  if (says !== null && says !== goalAmount(t.requirement)) {
    return { kind: 'count', says };
  }

  const canNameTarget = type === 'rip_count' || type === 'vault_pixel_count';
  if (canNameTarget && !goalName) {
    const targetId =
      type === 'rip_count'
        ? t.requirement.pack_id
        : t.requirement.pixel_pokemon_id;
    // A target that no longer exists has no name to compare: the row's label
    // already says "(missing)".
    if (targetId) return null;
    const word = goalPart
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .find((w) => w && !FILLER.has(w) && !/^\d/.test(w));
    if (word) return { kind: 'any', says: word };
  }
  if (canNameTarget && namedWord && !goalPart.includes(namedWord)) {
    return { kind: 'target', wants: goalName as string };
  }
  return null;
};

/** The least a player must spend to finish the goal, in RM. null = free to earn
 *  or not worth a sum (a pull depends on luck). */
export const leastSpend = (
  reqType: string,
  n: number,
  ripPrice: number | null,
): number | null =>
  reqType === 'rip_count' && ripPrice !== null
    ? n * ripPrice
    : reqType === 'topup_myr'
      ? n
      : null;

/** Same goal on the same target, so a week can't get the same task twice. */
export const sameGoal = (
  a: AdminTaskDefinition,
  b: AdminTaskDefinition,
): boolean =>
  a.kind === b.kind &&
  a.requirement.type === b.requirement.type &&
  goalAmount(a.requirement) === goalAmount(b.requirement) &&
  (a.requirement.pack_id ?? null) === (b.requirement.pack_id ?? null) &&
  (a.requirement.pixel_pokemon_id ?? null) ===
    (b.requirement.pixel_pokemon_id ?? null) &&
  JSON.stringify(rewardKey(a)) === JSON.stringify(rewardKey(b));

const rewardKey = (t: AdminTaskDefinition): unknown[] => [
  t.reward.type,
  t.reward.pack_id ?? null,
  t.reward.card_handle ?? null,
  t.reward.amount_myr ?? null,
  t.tickets ?? 0,
];
