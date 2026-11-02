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
  /** What the goal names, for the sentence, the name and the preview. `price`
   *  is the least one rip can cost. */
  goal: { name: string | null; image: string | null; price: number | null };
  /** What the reward names. `value` is its worth in RM, when it has one. */
  prize: { name: string | null; image: string | null; value: number | null };
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
    goal: t.view
      ? {
          name: t.view.goal_name,
          image: t.view.goal_image,
          price: t.view.goal_price_myr,
        }
      : NO_GOAL,
    prize: t.view
      ? {
          name: t.view.reward_name,
          image: t.view.reward_image,
          value: t.view.reward_value_myr,
        }
      : NO_PRIZE,
  };
};

// Mirrors MAX_TASK_TICKETS in the backend's lucky-draw.ts.
const MAX_TICKETS = 10_000;

export function draftToPayload(d: Draft): {
  requirement: Record<string, unknown>;
  reward: Record<string, unknown>;
  tickets: number;
} | null {
  // Always sent: the backend keeps the stored value only when the field is
  // omitted, so a save that left it out would be a silent "keep", not a "0".
  const tickets = d.tickets.trim() === '' ? NaN : Number(d.tickets);
  if (!Number.isInteger(tickets) || tickets < 0 || tickets > MAX_TICKETS) {
    return null;
  }
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
      requirement = { type: d.reqType, amount_myr: n };
      break;
    default:
      requirement = { type: d.reqType, count: n };
  }
  let reward: Record<string, unknown>;
  if (d.rewardType === '') return null;
  if (d.rewardType === 'credit') {
    const amount = Number(d.rewardValue);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    reward = { type: 'credit', amount_myr: amount };
  } else if (d.rewardType === 'pack') {
    if (!d.rewardValue.trim()) return null;
    reward = { type: 'pack', pack_id: d.rewardValue.trim() };
  } else if (d.rewardType === 'tickets') {
    // The amount travels in `tickets`; a tickets reward of 0 would pay nothing.
    if (tickets < 1) return null;
    reward = { type: 'tickets' };
  } else {
    if (!d.rewardValue.trim()) return null;
    reward = { type: 'card', card_handle: d.rewardValue.trim() };
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
    sort: Number(d.sort) || 0,
    tickets: payload.tickets,
    starts_at: toIso(d.startsAt),
    ends_at: toIso(d.endsAt),
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

/** What the sentence still needs, in reading order. */
export const draftMissing = (
  d: Draft,
): { step: BuilderStep; label: string }[] => {
  const out: { step: BuilderStep; label: string }[] = [];
  if (!d.reqType) out.push({ step: 'goal', label: 'the goal' });
  const n = Number(d.reqN);
  if (d.reqType && countApplies(d) && !(Number.isInteger(n) && n > 0)) {
    out.push({
      step: 'n',
      label:
        d.reqType === 'topup_myr'
          ? 'how much'
          : d.reqType === 'checkin_days'
            ? 'which day'
            : d.reqType === 'reach_level'
              ? 'which level'
              : 'how many',
    });
  }
  if (d.reqType === 'rip_count' && d.reqPack === '')
    out.push({ step: 'target', label: 'which pack' });
  if (d.reqType === 'vault_pixel_count' && d.reqPixel === '')
    out.push({ step: 'target', label: 'which Pokémon' });
  // A rule that names a target the form has no name for: a backend mid-deploy, or
  // a pack or Pokémon since deleted. A name written now would call it "any pack".
  if (d.reqType === 'rip_count' && d.reqPack && d.reqPack !== ANY && !d.goal.name)
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
    if (!(Number(d.tickets) >= 1))
      out.push({ step: 'value', label: 'how many tickets' });
  } else if (!d.rewardValue.trim() || d.rewardValue === '0') {
    out.push({
      step: 'value',
      label:
        d.rewardType === 'credit'
          ? 'how much credit'
          : d.rewardType === 'pack'
            ? 'which pack to give'
            : 'which card',
    });
  } else if (
    (d.rewardType === 'pack' || d.rewardType === 'card') &&
    !d.prize.name
  ) {
    out.push({
      step: 'value',
      label:
        d.rewardType === 'pack' ? 're-pick the pack to give' : 're-pick the card',
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

const rm = (n: number): string =>
  `RM ${n.toLocaleString('en-MY', { maximumFractionDigits: 2 })}`;

/**
 * Says out loud what the sentence would do: a check-in day already taken, a task
 * the week already has, and a reward worth more than the goal costs.
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

  const scope =
    d.reqType === 'rip_count'
      ? d.reqPack
      : d.reqType === 'vault_pixel_count'
        ? d.reqPixel
        : null;
  if (scope && scope !== ANY && n > 0) {
    const twin = others.find(
      (t) =>
        t.requirement.type === d.reqType &&
        goalAmount(t.requirement) === n &&
        (t.requirement.pack_id ?? t.requirement.pixel_pokemon_id) === scope,
    );
    if (twin) {
      out.push({
        tone: 'warn',
        text: `This week already has this goal: ${labelsOf(twin).requirement}, paying ${labelsOf(twin).reward}.`,
      });
    }
  }

  const spend = leastSpend(d.reqType, n, d.goal.price);
  const back =
    d.rewardType === 'credit' ? Number(d.rewardValue) : d.prize.value;
  if (spend && back && draftMissing(d).length === 0) {
    const pct = Math.round((back / spend) * 100);
    const sum = `The least a player spends is ${rm(spend)}. They get ${rm(back)} back (${pct}%).`;
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
  const claims = t.claims
    ? `${t.claims.toLocaleString('en-MY')} claimed.`
    : 'No claims yet.';
  const name = `“${t.title}”`;
  switch (issue.kind) {
    case 'any': {
      const what = t.requirement.type === 'rip_count' ? 'pack' : 'Pokémon';
      const price = t.view?.goal_price_myr ?? null;
      const value = t.view?.reward_value_myr ?? null;
      const n = goalAmount(t.requirement);
      const cost =
        price !== null
          ? `Cheapest way to earn it: ${n} × ${rm(price)} = ${rm(n * price)}. ${
              value !== null ? `It pays ${rm(value)}. ` : ''
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
      const pack =
        t.requirement.type === 'rip_count'
          ? packs.find(
              (p) =>
                p.prize_type !== 'tickets' &&
                p.title.toLowerCase().split(/\s+/)[0] === issue.says,
            )
          : undefined;
      const keep: IssueFix = {
        label: `Any ${t.requirement.type === 'rip_count' ? 'pack' : 'Pokémon'} is right`,
        note: 'The rule stays, and the name changes to say so.',
        action: 'patch',
      };
      if (!pack) return [open, keep];
      const short = capital(issue.says);
      return [
        {
          label: `Make it ${short} only`,
          note: `New claims will need ${n} ${short} rips. ${stay}`.trim(),
          action: 'patch',
          patch: (d) => ({
            ...d,
            reqPack: pack.slug,
            goal: { name: pack.title, image: pack.image, price: pack.price },
          }),
        },
        keep,
      ];
    }
    case 'count':
      return [
        {
          label: `Change rule to ${issue.says}`,
          note: `New claims will need ${issue.says}. ${stay}`.trim(),
          action: 'patch',
          patch: (d) => ({ ...d, reqN: String(issue.says) }),
        },
        {
          label: `${n} is right, rename`,
          note: `The rule stays at ${n}, and the name changes to match.`,
          action: 'patch',
        },
      ];
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

export const windowLabel = (t: AdminTaskDefinition): string =>
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
