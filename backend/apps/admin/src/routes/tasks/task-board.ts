// The Tasks board's pure half: which week a task belongs to, the name a rule
// writes for itself, and where an older hand-typed name parts from its rule.
// The name check exists because customers are paid by the rule while staff read
// the title, and the two can drift apart.
import type { AdminTaskDefinition } from '../../lib/admin-rest';

const MYT_MS = 8 * 3600_000;
const WEEK_MS = 7 * 24 * 3600_000;
const OVERRUN_MS = 2 * 3600_000;
// Leaves room in the backend's 120-character title for the goal and the tickets.
const MAX_CARD_IN_NAME = 60;

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

const when = (iso: string | null | undefined, fallback: number): number =>
  iso ? new Date(iso).getTime() : fallback;

/** A hand-typed window can run a little past the Monday reset (12:59 AM, say) or
 *  start just before it. That sliver doesn't make it part of the other week. */
const overlapsWeek = (t: AdminTaskDefinition, start: number): boolean => {
  const from = when(t.starts_at, -Infinity);
  const to = when(t.ends_at, Infinity);
  const overlap = Math.min(to, start + WEEK_MS) - Math.max(from, start);
  return overlap > 0 && (overlap >= OVERRUN_MS || overlap * 2 >= to - from);
};

/** Does this task run in the week? Retired tasks are listed apart. */
export const runsInWeek = (t: AdminTaskDefinition, start: number): boolean =>
  t.active && overlapsWeek(t, start);

/** Switched off, but it ran in this week before that. A row retired before
 *  retired_at existed has no date to place it by, so it stays on the Retired tab. */
export const retiredInWeek = (t: AdminTaskDefinition, start: number): boolean =>
  !t.active &&
  Boolean(t.retired_at) &&
  new Date(t.retired_at as string).getTime() >= start &&
  overlapsWeek(t, start);

/** The window as the viewed week would give it, give or take a typed overrun. */
export const coversWeek = (t: AdminTaskDefinition, start: number): boolean =>
  Math.abs(when(t.starts_at, start) - start) <= OVERRUN_MS &&
  Math.abs(when(t.ends_at, start + WEEK_MS) - (start + WEEK_MS)) <= OVERRUN_MS;

/** Where a row copied from `sourceWeek` should run. A whole week becomes the next
 *  whole week; a shorter window keeps its shape, one week on. */
export const copiedWindow = (
  t: AdminTaskDefinition,
  sourceWeek: number,
): { starts_at: string; ends_at: string; short: boolean } => {
  const target = addWeeks(sourceWeek, 1);
  if (coversWeek(t, sourceWeek)) {
    return {
      starts_at: new Date(target).toISOString(),
      ends_at: new Date(addWeeks(target, 1)).toISOString(),
      short: false,
    };
  }
  return {
    starts_at: new Date(when(t.starts_at, sourceWeek) + WEEK_MS).toISOString(),
    ends_at: new Date(
      when(t.ends_at, sourceWeek + WEEK_MS) + WEEK_MS,
    ).toISOString(),
    short: true,
  };
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

export const money = (n: number): string =>
  `RM ${n.toLocaleString('en-MY', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

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
  const card = p.rewardName ?? 'card';
  const main =
    p.rewardType === 'credit'
      ? `free ${money(p.rewardAmount)} bonus credit`
      : p.rewardType === 'pack'
        ? `free 1 ${shortPack(p.rewardName ?? 'pack')}`
        : `free ${
            card.length > MAX_CARD_IN_NAME
              ? `${card.slice(0, MAX_CARD_IN_NAME).trimEnd()}…`
              : card
          }`;
  return p.tickets > 0 ? `${main} + ${tickets}` : main;
};

/** The title a rule writes for itself. Staff never type one, so the two can't
 *  disagree. Close to how the team has been writing them by hand. */
export const taskName = (p: NameParts): string => {
  const { n, goalName } = p;
  const pokemonCards = `${n} Pokémon ${n === 1 ? 'card' : 'cards'}`;
  switch (p.reqType) {
    case 'checkin_days':
      return p.kind === 'daily'
        ? 'Check in today'
        : `Check in ${n} ${n === 1 ? 'day' : 'days'} this week`;
    case 'vault_pixel_count':
      if (p.kind === 'achievement')
        return goalName ? `Vault ${n} ${goalName}` : `Vault ${pokemonCards}`;
      return goalName
        ? `Pull ${n} ${goalName} (Graded or Ungraded)`
        : `Pull ${pokemonCards}`;
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
  | { kind: 'target'; wants: string }
  /** The name promises a different reward. */
  | { kind: 'reward'; says: string };

const GOAL_WORDS: [RegExp, string[]][] = [
  [/^check[\s-]?in/, ['checkin_days']],
  [/^(pull|collect)/, ['vault_pixel_count', 'vault_count']],
  [/^vault/, ['vault_pixel_count', 'vault_count']],
  [/^(daily )?(rip|open)/, ['rip_count']],
  [/^top\s?up/, ['topup_myr']],
  [/^reach/, ['reach_level']],
];

const FILLER = new Set(
  'rip open daily today pull collect vault any pack packs of all a an more rare new each per pokemon card cards graded or ungraded the this week x'.split(
    ' ',
  ),
);

/** Lower case, no accents, no hyphens or apostrophes: "Ho-Oh" and "Farfetch’d"
 *  read the same however they were typed. Keeps . and , for numbers. */
const normal = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[-–—:;!?()[\]"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const wordRe = (word: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
    'u',
  );

/** The count in a piece of title: "10", "x10", "10x", "1,000", "1 000", "1.5k". */
const readCount = (text: string): number | null => {
  // A space only groups thousands in money: "Rip 3 151" is 3 of the 151 pack.
  const plain = text
    .replace(/\brm\s?(\d{1,3}) (?=\d{3}\b)/g, '$1')
    .replace(/\brm\s?/g, ' ');
  const thousands = plain.match(
    /(?<![\p{L}\p{N}.,])(\d+(?:\.\d+)?)\s*k(?![\p{L}\p{N}])/u,
  );
  if (thousands) return Math.round(Number(thousands[1]) * 1000);
  const found = plain.match(
    /(?<![\p{L}\p{N}.,])x?(\d{1,3}(?:,\d{3})+|\d+)x?(?![\p{L}\p{N}])/u,
  );
  return found ? Number(found[1].replace(/,/g, '')) : null;
};

const readMoney = (text: string): number | null => {
  const found = text.match(/\d[\d,]*(?:\.\d+)?/);
  return found ? Number(found[0].replace(/,/g, '')) : null;
};

const firstWord = (s: string): string => s.split(' ')[0];

const rewardIssue = (
  t: AdminTaskDefinition,
  part: string,
): NameIssue | null => {
  if (!part) return null;
  const kind = t.reward.type;
  if (wordRe('ticket').test(part) || wordRe('tickets').test(part)) {
    const says = readCount(part);
    return says !== null && says !== (t.tickets ?? 0)
      ? { kind: 'reward', says: `${says} tickets` }
      : null;
  }
  if (kind === 'credit') {
    const says = readMoney(part);
    return says !== null && says !== Number(t.reward.amount_myr ?? 0)
      ? { kind: 'reward', says: money(says) }
      : null;
  }
  const name = t.view?.reward_name;
  if ((kind === 'pack' || kind === 'card') && name) {
    const word = firstWord(normal(shortPack(name)));
    return wordRe(word).test(part)
      ? null
      : { kind: 'reward', says: part.replace(/\s+pack$/, '') };
  }
  return null;
};

/**
 * Reads a hand-typed title and says where it parts from the rule. New titles
 * come from taskName and always pass; this is for the rows typed before that.
 * Calibrated on titles staff have really typed (see the test). A title it can't
 * read is left alone: a wrong guess here would offer a button that changes a rule.
 */
export const nameIssue = (t: AdminTaskDefinition): NameIssue | null => {
  const title = normal(t.title);
  const type = String(t.requirement.type ?? '');
  const said = GOAL_WORDS.find(([word]) => word.test(title));
  if (!said) return null;
  if (!said[1].includes(type)) {
    return { kind: 'goal', says: t.title.trim().split(/\s+/)[0] };
  }

  const isRip = type === 'rip_count';
  const isPull = type === 'vault_pixel_count';
  const goalName = t.view?.goal_name ?? null;
  // A variant is told apart by art and label; staff type the Pokémon's name.
  const named = goalName
    ? normal(isRip ? shortPack(goalName) : goalName.replace(/\s*\(.*\)$/, ''))
    : null;
  // The target's own name can hold "free", a comma or a number. Hide it first.
  const hasWholeName = named !== null && wordRe(named).test(title);
  const masked = hasWholeName
    ? title.replace(wordRe(named as string), ' § ')
    : title;
  const [goalPart, ...rest] = masked.split(/\b(?:free|win)\b|,\s/);

  // A pack named "30th" or "151": that number isn't the count.
  const packWord = isRip && named ? firstWord(named) : null;
  const says =
    readCount(packWord ? goalPart.replace(wordRe(packWord), ' ') : goalPart) ??
    (isRip || isPull ? 1 : null);
  if (says !== null && says !== goalAmount(t.requirement)) {
    return { kind: 'count', says };
  }

  if ((isRip || isPull || type === 'vault_count') && !named) {
    const targetId = isRip
      ? t.requirement.pack_id
      : t.requirement.pixel_pokemon_id;
    // A target that no longer exists has no name to compare: the row's label
    // already says "(missing)".
    if (targetId) return null;
    const word = goalPart
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .find(
        (w) =>
          w &&
          !FILLER.has(w) &&
          w.replace(/^x|x$/g, '') !== String(says) &&
          w !== 'rm',
      );
    if (word) return { kind: 'any', says: word };
  }

  if (isRip && named) {
    const capsule = wordRe('capsule');
    // A capsule spin is a cheap rip, so "Bronze" and "Bronze Capsule" must not pass
    // as the same pack. A whole name was hidden above, so count what it held.
    const saysCapsule =
      capsule.test(goalPart) || (hasWholeName && capsule.test(named));
    const mismatch =
      saysCapsule !== capsule.test(named) ||
      (!hasWholeName && !wordRe(firstWord(named)).test(goalPart));
    if (mismatch) return { kind: 'target', wants: goalName as string };
  }
  if (isPull && named) {
    const last = named.split(' ').at(-1) as string;
    if (!wordRe(last).test(goalPart) && !hasWholeName) {
      return { kind: 'target', wants: goalName as string };
    }
  }
  return rewardIssue(t, rest.join(' ').trim());
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

const targetOf = (t: AdminTaskDefinition): unknown =>
  t.requirement.type === 'rip_count'
    ? (t.requirement.pack_id ?? null)
    : t.requirement.type === 'vault_pixel_count'
      ? (t.requirement.pixel_pokemon_id ?? null)
      : null;

/** The same goal type on the same pack or Pokémon, whatever the count. */
export const sameTarget = (
  a: AdminTaskDefinition,
  b: AdminTaskDefinition,
): boolean =>
  a.kind === b.kind &&
  a.requirement.type === b.requirement.type &&
  targetOf(a) === targetOf(b);

const prizeOf = (t: AdminTaskDefinition): unknown =>
  t.reward.type === 'pack'
    ? (t.reward.pack_id ?? null)
    : t.reward.type === 'card'
      ? (t.reward.card_handle ?? null)
      : null;

/**
 * The same task, so a week must not get it twice. An edited ticket or credit
 * amount is still the same task, while "Pull 2" and "Pull 3" are separate tiers.
 * Each key is read by type, so a leftover from an older rule changes nothing.
 */
export const sameGoal = (
  a: AdminTaskDefinition,
  b: AdminTaskDefinition,
): boolean =>
  sameTarget(a, b) &&
  goalAmount(a.requirement) === goalAmount(b.requirement) &&
  a.reward.type === b.reward.type &&
  prizeOf(a) === prizeOf(b);
