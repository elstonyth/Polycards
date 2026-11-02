// The Tasks console's pure half: the shape the form edits, how a saved task
// becomes that shape, and how it becomes a payload again. Split out of page.tsx
// so it can be unit-tested — the same arrangement vip-levels-validate-client.ts
// has, and for the same reason: the round-trip is where a form silently drops a
// field, and a component test would not reach it here (the admin vitest runner
// is node-environment with no plugins, by deliberate choice).
import type { AdminTaskDefinition } from '../../lib/admin-rest';
import { orderDateTime } from '../../lib/format';
import {
  goalAmount,
  leastSpend,
  money,
  shortPack,
  taskName,
  type NameIssue,
  type NameParts,
} from './task-board';

export type TaskKind = AdminTaskDefinition['kind'];

// Mirrors TYPES_BY_KIND in the backend's tasks.ts (the gate that matters):
// daily and weekly share the repeating goals; lifetime ratchets (VIP level,
// vault size) are achievement-only.
const PERIODIC = [
  'checkin_days',
  'rip_count',
  'vault_pixel_count',
  'topup_myr',
] as const;
export const REQUIREMENT_TYPES: Record<TaskKind, readonly string[]> = {
  daily: PERIODIC,
  weekly: PERIODIC,
  achievement: ['reach_level', 'vault_count', 'vault_pixel_count', 'topup_myr'],
};

export const KIND_LABEL: Record<TaskKind, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  achievement: 'Once per account',
};

export const REQUIREMENT_LABEL: Record<string, string> = {
  checkin_days: 'Check in on N days',
  rip_count: 'Rip N packs',
  reach_level: 'Reach VIP level N',
  vault_count: 'Vault N cards',
  vault_pixel_count: 'Vault N Pokémon (pixel) cards',
  topup_myr: 'Top up RM N',
};

/** The goal select's wording for one cadence. A daily check-in is a single
 *  day's tap; a repeating pixel goal counts that period's PULLS, not the
 *  cards ever vaulted. */
export const requirementLabel = (kind: TaskKind, type: string): string => {
  if (kind === 'daily' && type === 'checkin_days') return 'Check in today';
  if (kind !== 'achievement' && type === 'vault_pixel_count')
    return 'Pull N Pokémon (pixel) cards';
  return REQUIREMENT_LABEL[type] ?? type;
};

/** Whether the goal takes a number at all — a daily check-in is always 1. */
export const countApplies = (d: Pick<Draft, 'kind' | 'reqType'>): boolean =>
  !(d.kind === 'daily' && d.reqType === 'checkin_days');

export const REWARD_TYPES = ['credit', 'pack', 'card', 'tickets'] as const;

export const REWARD_LABEL: Record<string, string> = {
  credit: 'Bonus credit (RM)',
  pack: 'Free rip of a pack',
  card: 'A specific card',
  tickets: 'Lucky Draw tickets',
};

/**
 * "Any pack" or "any Pokémon", chosen on purpose. A blank scope ('') is one
 * nobody has chosen yet, and can't be saved.
 */
export const ANY = '__any__';

export interface Draft {
  id?: string;
  kind: TaskKind;
  /** The name the row was saved with, shown when it is about to change. New
   *  names are written from the rule, never typed. */
  title: string;
  reqType: string;
  reqN: string;
  /** rip_count: which pack ('' = not chosen, ANY = any pack). */
  reqPack: string;
  /** vault_pixel_count: which pixel Pokémon ('' = not chosen, ANY = any). */
  reqPixel: string;
  rewardType: (typeof REWARD_TYPES)[number] | '';
  rewardValue: string;
  active: boolean;
  sort: string;
  /** Lucky Draw tickets a claim also pays (whole number, 0 = none); the whole
   *  payout of a tickets reward. */
  tickets: string;
  /** datetime-local strings, same idiom as the Weekly Challenge schedule. */
  startsAt: string;
  endsAt: string;
  /** The window as stored. The form only holds minutes, so an untouched field
   *  goes back as this, to the second. */
  saved?: { starts_at: string | null; ends_at: string | null };
  /** What the goal names, for the sentence, the name and the preview. `price`
   *  is the least one rip can cost. `buyable` is false when players can't open
   *  that pack right now. */
  goal: {
    name: string | null;
    image: string | null;
    price: number | null;
    buyable?: boolean | null;
  };
  /** What the reward names. `value` is its worth in RM, when it has one. */
  prize: {
    name: string | null;
    image: string | null;
    value: number | null;
    grade?: string | null;
  };
}

export const NO_GOAL: Draft['goal'] = { name: null, image: null, price: null };
export const NO_PRIZE: Draft['prize'] = {
  name: null,
  image: null,
  value: null,
};

/**
 * Nothing is chosen for the operator. These used to default to a valid "check
 * in 1 day, any pack, count 1", so a form filled in with only a name and a
 * reward saved happily, and a default nobody chose became the rule.
 */
export const blankDraft = (): Draft => ({
  kind: 'weekly',
  title: '',
  reqType: '',
  reqN: '',
  reqPack: '',
  reqPixel: '',
  rewardType: '',
  rewardValue: '',
  active: true,
  sort: '0',
  tickets: '0',
  startsAt: '',
  endsAt: '',
  goal: NO_GOAL,
  prize: NO_PRIZE,
});

/** '' → null; anything else → the ISO instant the browser wall-clock means. */
export const toIso = (local: string): string | null => {
  if (local === '') return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Browser wall-clock string for a datetime-local input. */
export const toLocalInput = (d: Date): string =>
  Number.isFinite(d.getTime())
    ? new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16)
    : '';

export const draftFrom = (t: AdminTaskDefinition): Draft => {
  const req = t.requirement as Record<string, unknown>;
  const rew = t.reward as Record<string, unknown>;
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    reqType: String(req.type ?? ''),
    reqN: String(goalAmount(req)),
    reqPack: typeof req.pack_id === 'string' && req.pack_id ? req.pack_id : ANY,
    reqPixel:
      typeof req.pixel_pokemon_id === 'string' && req.pixel_pokemon_id
        ? req.pixel_pokemon_id
        : ANY,
    rewardType: (rew.type as Draft['rewardType']) ?? '',
    rewardValue:
      rew.type === 'credit'
        ? String(rew.amount_myr ?? '')
        : rew.type === 'pack'
          ? String(rew.pack_id ?? '')
          : String(rew.card_handle ?? ''),
    active: t.active,
    sort: String(t.sort),
    tickets: String(t.tickets ?? 0),
    startsAt: t.starts_at ? toLocalInput(new Date(t.starts_at)) : '',
    endsAt: t.ends_at ? toLocalInput(new Date(t.ends_at)) : '',
    saved: { starts_at: t.starts_at, ends_at: t.ends_at },
    goal: t.view
      ? {
          name: t.view.goal_name,
          image: t.view.goal_image,
          price: t.view.goal_price_myr,
          buyable: t.view.goal_buyable ?? null,
        }
      : NO_GOAL,
    prize: t.view
      ? {
          name: t.view.reward_name,
          image: t.view.reward_image,
          value: t.view.reward_value_myr,
          grade: t.view.reward_grade ?? null,
        }
      : NO_PRIZE,
  };
};

// Mirrors MAX_TASK_TICKETS in the backend's lucky-draw.ts.
const MAX_TICKETS = 10_000;
// Mirror the ceilings in the backend's tasks.ts and saveTaskDefinition. A refusal
// there would stop a week's publish partway, so they are refused here first.
const MAX_CREDIT_MYR = 10_000;
const MAX_TOPUP_MYR = 100_000;
const MAX_LEVEL = 100;
const MAX_TITLE = 120;

const validCredit = (value: string): boolean => {
  const amount = Number(value);
  return (
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= MAX_CREDIT_MYR &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6
  );
};

const validTickets = (value: string): boolean => {
  const n = value.trim() === '' ? NaN : Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_TICKETS;
};

export function draftToPayload(d: Draft): {
  requirement: Record<string, unknown>;
  reward: Record<string, unknown>;
  tickets: number;
} | null {
  // Always sent: the backend keeps the stored value only when the field is
  // omitted, so a save that left it out would be a silent "keep", not a "0".
  if (!validTickets(d.tickets)) return null;
  const tickets = Number(d.tickets);
  // A goal with no count box (the daily check-in) must not be blocked by
  // whatever the hidden box last held — the operator could not fix it.
  const n = countApplies(d) ? Number(d.reqN) : 1;
  if (!Number.isInteger(n) || n <= 0) return null;
  let requirement: Record<string, unknown>;
  switch (d.reqType) {
    case '':
      return null;
    case 'checkin_days':
      // A day holds one check-in and a week seven — the backend refuses
      // anything else, so refuse it here before the round trip.
      if (d.kind === 'daily') {
        requirement = { type: d.reqType, days: 1 };
        break;
      }
      if (n > 7) return null;
      requirement = { type: d.reqType, days: n };
      break;
    case 'rip_count':
      if (d.reqPack === '') return null;
      requirement = {
        type: d.reqType,
        count: n,
        pack_id: d.reqPack === ANY ? null : d.reqPack,
      };
      break;
    case 'reach_level':
      if (n > MAX_LEVEL) return null;
      requirement = { type: d.reqType, level: n };
      break;
    case 'vault_pixel_count':
      if (d.reqPixel === '') return null;
      requirement = {
        type: d.reqType,
        count: n,
        pixel_pokemon_id: d.reqPixel === ANY ? null : d.reqPixel,
      };
      break;
    case 'topup_myr':
      if (n > MAX_TOPUP_MYR) return null;
      requirement = { type: d.reqType, amount_myr: n };
      break;
    default:
      requirement = { type: d.reqType, count: n };
  }
  let reward: Record<string, unknown>;
  switch (d.rewardType) {
    case 'credit':
      if (!validCredit(d.rewardValue)) return null;
      reward = { type: 'credit', amount_myr: Number(d.rewardValue) };
      break;
    case 'pack':
      if (!d.rewardValue.trim()) return null;
      reward = { type: 'pack', pack_id: d.rewardValue.trim() };
      break;
    case 'tickets':
      // The amount travels in `tickets`; a tickets reward of 0 would pay nothing.
      if (tickets < 1) return null;
      reward = { type: 'tickets' };
      break;
    case 'card':
      if (!d.rewardValue.trim()) return null;
      reward = { type: 'card', card_handle: d.rewardValue.trim() };
      break;
    default:
      return null;
  }
  return { requirement, reward, tickets };
}

export const draftParts = (d: Draft): NameParts => ({
  kind: d.kind,
  reqType: d.reqType,
  n: countApplies(d) ? Number(d.reqN) : 1,
  goalName: d.goal.name,
  rewardType: d.rewardType,
  rewardName: d.prize.name,
  rewardAmount: Number(d.rewardValue),
  tickets: Number(d.tickets) || 0,
});

/** The stored instant when the field is untouched, so seconds aren't lost. */
const windowIso = (local: string, stored?: string | null): string | null =>
  stored && toLocalInput(new Date(stored)) === local ? stored : toIso(local);

/** The whole save for a draft, its name written from its rule. */
export const draftToInput = (d: Draft, reason: string) => {
  const payload = draftToPayload(d);
  // A complete payload can still lack the words its name needs (see draftMissing).
  if (!payload || draftMissing(d).length > 0) return null;
  return {
    id: d.id,
    kind: d.kind,
    title: taskName(draftParts(d)),
    requirement: payload.requirement,
    reward: payload.reward,
    active: d.active,
    // The route only takes a whole number, and would read 1.5 as 0.
    sort: Math.trunc(Number(d.sort)) || 0,
    tickets: payload.tickets,
    starts_at: windowIso(d.startsAt, d.saved?.starts_at),
    ends_at: windowIso(d.endsAt, d.saved?.ends_at),
    reason,
  };
};

/**
 * A half-typed datetime is neither empty nor valid. Refusing the save beats
 * silently sending null, which would publish a task the operator meant to
 * schedule for later.
 */
export const scheduleOk = (d: Pick<Draft, 'startsAt' | 'endsAt'>): boolean =>
  (d.startsAt === '' || toIso(d.startsAt) !== null) &&
  (d.endsAt === '' || toIso(d.endsAt) !== null) &&
  (d.startsAt === '' ||
    d.endsAt === '' ||
    new Date(d.endsAt).getTime() > new Date(d.startsAt).getTime());

export type BuilderStep =
  | 'repeat'
  | 'goal'
  | 'n'
  | 'target'
  | 'reward'
  | 'value';

const countMissing = (d: Draft): string | null => {
  const n = Number(d.reqN);
  const blank = d.reqN.trim() === '';
  if (d.reqType === 'topup_myr') {
    if (blank) return 'how much';
    return Number.isInteger(n) && n > 0 && n <= MAX_TOPUP_MYR
      ? null
      : 'a whole RM amount up to RM 100,000';
  }
  if (d.reqType === 'checkin_days') {
    if (blank) return 'which day';
    return Number.isInteger(n) && n >= 1 && n <= 7 ? null : 'a day from 1 to 7';
  }
  if (d.reqType === 'reach_level') {
    if (blank) return 'which level';
    return Number.isInteger(n) && n >= 1 && n <= MAX_LEVEL
      ? null
      : 'a level from 1 to 100';
  }
  if (blank) return 'how many';
  return Number.isInteger(n) && n > 0 ? null : 'a whole number above 0';
};

/** What the sentence still needs, in reading order. Anything that would stop a
 *  save is named here, so a greyed-out button always has a reason beside it. */
export const draftMissing = (
  d: Draft,
): { step: BuilderStep; label: string }[] => {
  const out: { step: BuilderStep; label: string }[] = [];
  if (!d.reqType) out.push({ step: 'goal', label: 'the goal' });
  if (d.reqType && countApplies(d)) {
    const label = countMissing(d);
    if (label) out.push({ step: 'n', label });
  }
  if (d.reqType === 'rip_count' && d.reqPack === '')
    out.push({ step: 'target', label: 'which pack' });
  if (d.reqType === 'vault_pixel_count' && d.reqPixel === '')
    out.push({ step: 'target', label: 'which Pokémon' });
  // A rule that names a target the form has no name for: a backend mid-deploy, or
  // a pack or Pokémon since deleted. A name written now would call it "any pack".
  if (
    d.reqType === 'rip_count' &&
    d.reqPack &&
    d.reqPack !== ANY &&
    !d.goal.name
  )
    out.push({ step: 'target', label: 're-pick the pack' });
  if (
    d.reqType === 'vault_pixel_count' &&
    d.reqPixel &&
    d.reqPixel !== ANY &&
    !d.goal.name
  )
    out.push({ step: 'target', label: 're-pick the Pokémon' });

  if (!d.rewardType) {
    out.push({ step: 'reward', label: 'the reward' });
  } else if (d.rewardType === 'tickets') {
    const n = Number(d.tickets);
    if (d.tickets.trim() === '' || n === 0)
      out.push({ step: 'value', label: 'how many tickets' });
    else if (!validTickets(d.tickets))
      out.push({
        step: 'value',
        label: 'a whole number of tickets up to 10,000',
      });
  } else if (d.rewardType === 'credit') {
    if (d.rewardValue.trim() === '')
      out.push({ step: 'value', label: 'how much credit' });
    else if (!validCredit(d.rewardValue))
      out.push({
        step: 'value',
        label: 'credit above RM 0, up to RM 10,000, in whole sen',
      });
  } else if (!d.rewardValue.trim()) {
    out.push({
      step: 'value',
      label: d.rewardType === 'pack' ? 'which pack to give' : 'which card',
    });
  } else if (!d.prize.name) {
    out.push({
      step: 'value',
      label:
        d.rewardType === 'pack'
          ? 're-pick the pack to give'
          : 're-pick the card',
    });
  }
  if (d.rewardType && d.rewardType !== 'tickets' && !validTickets(d.tickets)) {
    out.push({
      step: 'reward',
      label: 'a whole number for Tickets on top, in More options',
    });
  }
  if (out.length === 0 && taskName(draftParts(d)).length > MAX_TITLE) {
    out.push({
      step: 'target',
      label: `a shorter name: this one is over ${MAX_TITLE} characters`,
    });
  }
  return out;
};

/** Any pack counts every paid rip, so it must be ticked, not just picked. */
export const needsAnyConfirm = (d: Draft): boolean =>
  d.reqType === 'rip_count' && d.reqPack === ANY;

export interface BuilderCheck {
  tone: 'ok' | 'warn' | 'info';
  text: string;
}

/**
 * Says out loud what the sentence would do: a check-in day already taken, a task
 * the week already has, a pack players can't open, and a reward worth more than
 * the goal costs.
 */
export const draftChecks = (
  d: Draft,
  weekRows: AdminTaskDefinition[],
  claims = 0,
): BuilderCheck[] => {
  const out: BuilderCheck[] = [];
  const others = weekRows.filter((t) => t.id !== d.id);
  const n = Number(d.reqN);

  if (d.kind === 'weekly' && d.reqType === 'checkin_days' && n > 0) {
    const taken = others.filter(
      (t) =>
        t.requirement.type === 'checkin_days' &&
        goalAmount(t.requirement) === n,
    );
    out.push(
      taken.length
        ? {
            tone: 'warn',
            text: `Day ${n} already pays ${taken.map((t) => labelsOf(t).reward).join(' and ')}. This adds a second reward, and players get both.`,
          }
        : { tone: 'ok', text: `Day ${n} has nothing else on it.` },
    );
  }

  if (d.kind === 'weekly' && d.reqType !== 'checkin_days' && n > 0) {
    const scope =
      d.reqType === 'rip_count'
        ? d.reqPack
        : d.reqType === 'vault_pixel_count'
          ? d.reqPixel
          : null;
    const twin =
      scope === ''
        ? undefined
        : others.find(
            (t) =>
              t.kind === 'weekly' &&
              t.requirement.type === d.reqType &&
              goalAmount(t.requirement) === n &&
              (scope === null ||
                ((d.reqType === 'rip_count'
                  ? t.requirement.pack_id
                  : t.requirement.pixel_pokemon_id) ?? ANY) === scope),
          );
    if (twin) {
      out.push({
        tone: 'warn',
        text: `This week already has this goal: ${labelsOf(twin).requirement}, paying ${labelsOf(twin).reward}.`,
      });
    }
  }

  if (d.reqType === 'rip_count' && d.goal.buyable === false) {
    out.push({
      tone: 'warn',
      text: `Players can't rip ${d.goal.name ?? 'this pack'} right now, so they can't finish this goal.`,
    });
  }

  const spend = leastSpend(d.reqType, n, d.goal.price);
  const back =
    d.rewardType === 'credit' ? Number(d.rewardValue) : d.prize.value;
  if (spend && back && draftMissing(d).length === 0) {
    const pct = Math.round((back / spend) * 100);
    const sum = `The least a player spends is ${money(spend)}. They get ${money(back)} back (${pct}%).`;
    out.push(
      pct > 100
        ? {
            tone: 'warn',
            text: `${sum} The reward is worth more than the goal costs.`,
          }
        : { tone: 'ok', text: sum },
    );
  }

  if (claims > 0) {
    out.push({
      tone: 'info',
      text: `${claims.toLocaleString('en-MY')} already claimed. They keep it. New claims follow this rule.`,
    });
  }
  return out;
};

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A name-and-rule mismatch in plain words. */
export const issueText = (
  t: AdminTaskDefinition,
  issue: NameIssue,
): { headline: string; detail: string } => {
  const claims =
    t.claims === undefined
      ? ''
      : t.claims
        ? `${t.claims.toLocaleString('en-MY')} claimed.`
        : 'No claims yet.';
  const name = `“${t.title}”`;
  switch (issue.kind) {
    case 'any': {
      const what =
        t.requirement.type === 'rip_count'
          ? 'pack'
          : t.requirement.type === 'vault_count'
            ? 'card'
            : 'Pokémon';
      const price = t.view?.goal_price_myr ?? null;
      const value = t.view?.reward_value_myr ?? null;
      const n = goalAmount(t.requirement);
      const cost =
        price !== null
          ? `Cheapest way to earn it: ${n} × ${money(price)} = ${money(n * price)}. ${
              value !== null ? `It pays ${money(value)}. ` : ''
            }`
          : '';
      return {
        headline: `${name} says ${capital(issue.says)}. The rule counts any ${what}.`,
        detail: `${cost}${claims}`,
      };
    }
    case 'count':
      return {
        headline: `${name} says ${issue.says}. The rule pays at ${goalAmount(t.requirement)}.`,
        detail: claims,
      };
    case 'goal':
      return {
        headline: `${name} says ${issue.says}. The rule is: ${labelsOf(t).requirement}.`,
        detail: claims,
      };
    case 'target':
      return {
        headline: `${name} doesn't mention ${issue.wants}, which is what the rule counts.`,
        detail: claims,
      };
    case 'reward':
      return {
        headline: `${name} says ${issue.says}. The rule pays ${labelsOf(t).reward}.`,
        detail: claims,
      };
  }
};

export interface IssueFix {
  label: string;
  /** What the confirmation says will happen. */
  note: string;
  action: 'patch' | 'open' | 'retire';
  patch?: (d: Draft) => Draft;
}

/** The ways out of a mismatch. Packs is only needed to name "Bronze only". */
export const issueFixes = (
  t: AdminTaskDefinition,
  issue: NameIssue,
  packs: {
    slug: string;
    title: string;
    image: string;
    price: number;
    prize_type?: string;
    status?: string;
    in_stock?: boolean;
  }[] = [],
): IssueFix[] => {
  const stay = t.claims
    ? `The ${t.claims.toLocaleString('en-MY')} already claimed stay.`
    : '';
  const open: IssueFix = {
    label: 'Open and fix',
    note: '',
    action: 'open',
  };
  const n = goalAmount(t.requirement);
  switch (issue.kind) {
    case 'any': {
      const candidates =
        t.requirement.type === 'rip_count'
          ? packs.filter(
              (p) =>
                p.status === 'active' &&
                p.in_stock !== false &&
                p.price > 0 &&
                p.prize_type !== 'tickets' &&
                shortPack(p.title).toLowerCase() === issue.says,
            )
          : [];
      const what =
        t.requirement.type === 'rip_count'
          ? 'pack'
          : t.requirement.type === 'vault_count'
            ? 'card'
            : 'Pokémon';
      const keep: IssueFix = {
        label: `Any ${what} is right`,
        note: 'The rule stays, and the name changes to say so.',
        action: 'patch',
      };
      // Only when the name can only mean one pack on sale. Otherwise a person picks.
      if (candidates.length !== 1) return [open, keep];
      const pack = candidates[0];
      const short = shortPack(pack.title);
      return [
        {
          label: `Make it ${short} only`,
          note: `New claims will need ${n} ${pack.title} rips. ${stay}`.trim(),
          action: 'patch',
          patch: (d) => ({
            ...d,
            reqPack: pack.slug,
            goal: {
              name: pack.title,
              image: pack.image,
              price: pack.price,
              buyable: true,
            },
          }),
        },
        keep,
      ];
    }
    case 'count': {
      const rename: IssueFix = {
        label: `${n} is right, rename`,
        note: `The rule stays at ${n}, and the name changes to match.`,
        action: 'patch',
        patch: (d) => ({ ...d, reqN: String(n) }),
      };
      // Only offer a rule that can hold that number: a daily check-in is always
      // one, and a week has seven days.
      const possible = draftToPayload({
        ...draftFrom(t),
        reqN: String(issue.says),
      });
      if (
        !possible ||
        issue.says <= 0 ||
        goalAmount(possible.requirement) !== issue.says
      ) {
        return [open, rename];
      }
      return [
        {
          label: `Change rule to ${issue.says}`,
          note: `New claims will need ${issue.says}. ${stay}`.trim(),
          action: 'patch',
          patch: (d) => ({ ...d, reqN: String(issue.says) }),
        },
        rename,
      ];
    }
    case 'goal':
      return [
        open,
        {
          label: 'Retire it',
          note: `It leaves /task now. ${stay}`.trim(),
          action: 'retire',
        },
      ];
    case 'target':
      return [
        open,
        {
          label: 'Rule is right, rename',
          note: 'The rule stays, and the name changes to match.',
          action: 'patch',
        },
      ];
    case 'reward':
      return [
        open,
        {
          label: 'Reward is right, rename',
          note: 'The reward stays, and the name changes to match.',
          action: 'patch',
        },
      ];
  }
};

/**
 * `labels` is a NEW field. During a deploy the admin bundle ships either side
 * of the backend, so a response without it must still render — the alternative
 * is the whole console erroring out on `undefined.requirement`. Falling back to
 * the raw type is ugly but legible, and self-heals when the backend catches up.
 */
export const labelsOf = (
  t: AdminTaskDefinition,
): { requirement: string; reward: string } =>
  t.labels ?? {
    requirement: String(
      (t.requirement as Record<string, unknown>)?.type ?? '—',
    ),
    reward: String((t.reward as Record<string, unknown>)?.type ?? '—'),
  };

const dateLabel = (iso: string | null): string =>
  iso ? orderDateTime(iso) : '—';

export const windowLabel = (t: {
  starts_at: string | null;
  ends_at: string | null;
}): string =>
  t.starts_at || t.ends_at
    ? `${dateLabel(t.starts_at)} → ${dateLabel(t.ends_at)}`
    : 'Always on';

export type TaskStatus = 'live' | 'upcoming' | 'ended' | 'retired';

/**
 * Where a task stands for players at `now`. Same bounds as the backend's
 * taskIsLive (modules/packs/tasks.ts): a start in the future hides it, an end
 * at or before now hides it. `ended` is a task still switched on whose window
 * has closed — players can neither see nor claim it, so the list badges it as
 * such instead of the old "active".
 */
export const taskStatus = (t: AdminTaskDefinition, now: number): TaskStatus => {
  if (!t.active) return 'retired';
  if (t.starts_at && new Date(t.starts_at).getTime() > now) return 'upcoming';
  if (t.ends_at && new Date(t.ends_at).getTime() <= now) return 'ended';
  return 'live';
};
