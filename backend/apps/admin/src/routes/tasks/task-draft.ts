// The Tasks console's pure half: the shape the form edits, how a saved task
// becomes that shape, and how it becomes a payload again. Split out of page.tsx
// so it can be unit-tested — the same arrangement vip-levels-validate-client.ts
// has, and for the same reason: the round-trip is where a form silently drops a
// field, and a component test would not reach it here (the admin vitest runner
// is node-environment with no plugins, by deliberate choice).
import type { AdminTaskDefinition } from '../../lib/admin-rest';

export const REQUIREMENT_TYPES: Record<
  'weekly' | 'achievement',
  readonly string[]
> = {
  weekly: ['checkin_days', 'rip_count'],
  achievement: ['reach_level', 'vault_count', 'vault_pixel_count'],
};

export const REQUIREMENT_LABEL: Record<string, string> = {
  checkin_days: 'Check in on N days',
  rip_count: 'Rip N packs',
  reach_level: 'Reach VIP level N',
  vault_count: 'Vault N cards',
  vault_pixel_count: 'Vault N Pokémon (pixel) cards',
};

/** What the number beside the requirement select actually counts. */
export const COUNT_LABEL: Record<string, string> = {
  checkin_days: 'Days',
  rip_count: 'Packs',
  reach_level: 'Level',
  vault_count: 'Cards',
  vault_pixel_count: 'Cards',
};

export const REWARD_TYPES = ['credit', 'pack', 'card'] as const;

export const REWARD_LABEL: Record<string, string> = {
  credit: 'Credit (RM)',
  pack: 'Free rip of a pack',
  card: 'A specific card',
};

/**
 * Select.Item cannot carry an empty value, so "no specific one" needs a
 * sentinel that never collides with a real slug / handle / id.
 */
export const ANY = '__any__';

export interface Draft {
  id?: string;
  kind: 'weekly' | 'achievement';
  title: string;
  reqType: string;
  reqN: string;
  /** rip_count: which pack (ANY = any pack). */
  reqPack: string;
  /** vault_pixel_count: which pixel Pokémon (ANY = any linked pixel card). */
  reqPixel: string;
  rewardType: (typeof REWARD_TYPES)[number];
  rewardValue: string;
  active: boolean;
  sort: string;
  /** datetime-local strings, same idiom as the Weekly Challenge schedule. */
  startsAt: string;
  endsAt: string;
}

export const blankDraft = (): Draft => ({
  kind: 'weekly',
  title: '',
  reqType: 'checkin_days',
  reqN: '1',
  reqPack: ANY,
  reqPixel: ANY,
  rewardType: 'credit',
  rewardValue: '',
  active: true,
  sort: '0',
  startsAt: '',
  endsAt: '',
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
  const n =
    (req.days as number | undefined) ??
    (req.count as number | undefined) ??
    (req.level as number | undefined) ??
    1;
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    reqType: String(req.type ?? 'checkin_days'),
    reqN: String(n),
    reqPack: typeof req.pack_id === 'string' && req.pack_id ? req.pack_id : ANY,
    reqPixel:
      typeof req.pixel_pokemon_id === 'string' && req.pixel_pokemon_id
        ? req.pixel_pokemon_id
        : ANY,
    rewardType: (rew.type as Draft['rewardType']) ?? 'credit',
    rewardValue:
      rew.type === 'credit'
        ? String(rew.amount_myr ?? '')
        : rew.type === 'pack'
          ? String(rew.pack_id ?? '')
          : String(rew.card_handle ?? ''),
    active: t.active,
    sort: String(t.sort),
    startsAt: t.starts_at ? toLocalInput(new Date(t.starts_at)) : '',
    endsAt: t.ends_at ? toLocalInput(new Date(t.ends_at)) : '',
  };
};

export function draftToPayload(d: Draft): {
  requirement: Record<string, unknown>;
  reward: Record<string, unknown>;
} | null {
  const n = Number(d.reqN);
  if (!Number.isInteger(n) || n <= 0) return null;
  let requirement: Record<string, unknown>;
  switch (d.reqType) {
    case 'checkin_days':
      requirement = { type: d.reqType, days: n };
      break;
    case 'rip_count':
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
      requirement = {
        type: d.reqType,
        count: n,
        pixel_pokemon_id: d.reqPixel === ANY ? null : d.reqPixel,
      };
      break;
    default:
      requirement = { type: d.reqType, count: n };
  }
  let reward: Record<string, unknown>;
  if (d.rewardType === 'credit') {
    const amount = Number(d.rewardValue);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    reward = { type: 'credit', amount_myr: amount };
  } else if (d.rewardType === 'pack') {
    if (!d.rewardValue.trim()) return null;
    reward = { type: 'pack', pack_id: d.rewardValue.trim() };
  } else {
    if (!d.rewardValue.trim()) return null;
    reward = { type: 'card', card_handle: d.rewardValue.trim() };
  }
  return { requirement, reward };
}

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
  iso ? new Date(iso).toLocaleString() : '—';

export const windowLabel = (t: AdminTaskDefinition): string =>
  t.starts_at || t.ends_at
    ? `${dateLabel(t.starts_at)} → ${dateLabel(t.ends_at)}`
    : 'Always on';
