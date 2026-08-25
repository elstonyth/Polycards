import { describe, expect, test } from 'vitest';
import {
  ANY,
  blankDraft,
  draftFrom,
  draftToPayload,
  labelsOf,
  scheduleOk,
  toIso,
  windowLabel,
  type Draft,
} from './task-draft';
import type { AdminTaskDefinition } from '../../lib/admin-rest';

const task = (
  over: Partial<AdminTaskDefinition> = {},
): AdminTaskDefinition => ({
  id: 'task_1',
  kind: 'weekly',
  title: 'Check in 3 days this week',
  requirement: { type: 'checkin_days', days: 3 },
  reward: { type: 'credit', amount_myr: 5 },
  active: true,
  sort: 0,
  starts_at: null,
  ends_at: null,
  labels: { requirement: 'Check in on 3 days this week', reward: 'RM 5.00' },
  ...over,
});

// The round trip is where a form silently drops a field: open a saved task,
// change nothing, save — the payload must be what came in.
describe('draftFrom → draftToPayload round-trips every requirement shape', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['checkin_days', { type: 'checkin_days', days: 3 }],
    ['rip_count (any pack)', { type: 'rip_count', count: 3, pack_id: null }],
    [
      'rip_count (scoped)',
      { type: 'rip_count', count: 2, pack_id: 'bronze-pack' },
    ],
    ['reach_level', { type: 'reach_level', level: 20 }],
    ['vault_count', { type: 'vault_count', count: 10 }],
    [
      'vault_pixel_count (any)',
      { type: 'vault_pixel_count', count: 3, pixel_pokemon_id: null },
    ],
    [
      'vault_pixel_count (scoped)',
      { type: 'vault_pixel_count', count: 3, pixel_pokemon_id: 'px_25' },
    ],
  ];

  test.each(cases)('%s', (_name, requirement) => {
    const kind =
      requirement.type === 'checkin_days' || requirement.type === 'rip_count'
        ? ('weekly' as const)
        : ('achievement' as const);
    const payload = draftToPayload(draftFrom(task({ kind, requirement })));
    expect(payload!.requirement).toEqual(requirement);
  });

  test.each([
    ['credit', { type: 'credit', amount_myr: 5 }],
    ['pack', { type: 'pack', pack_id: 'bronze-pack' }],
    ['card', { type: 'card', card_handle: 'charizard-psa10' }],
  ])('reward: %s', (_name, reward) => {
    const payload = draftToPayload(draftFrom(task({ reward })));
    expect(payload!.reward).toEqual(reward);
  });
});

describe('draftFrom', () => {
  test('maps an absent scope to the ANY sentinel, not to an empty string', () => {
    // Select.Item cannot hold '', so an empty value would make the control
    // unselectable and the "Any pack" option unreachable.
    const d = draftFrom(
      task({ requirement: { type: 'rip_count', count: 1, pack_id: null } }),
    );
    expect(d.reqPack).toBe(ANY);
    expect(d.reqPixel).toBe(ANY);
  });

  test('carries the id, so the form knows to lock cadence and say "Save changes"', () => {
    expect(draftFrom(task()).id).toBe('task_1');
    expect(blankDraft().id).toBeUndefined();
  });
});

describe('draftToPayload rejects what the backend would reject', () => {
  const d = (over: Partial<Draft>): Draft => ({ ...blankDraft(), ...over });

  test('a non-positive or fractional count', () => {
    expect(draftToPayload(d({ reqN: '0' }))).toBeNull();
    expect(draftToPayload(d({ reqN: '-1' }))).toBeNull();
    expect(draftToPayload(d({ reqN: '2.5' }))).toBeNull();
    expect(draftToPayload(d({ reqN: '' }))).toBeNull();
  });

  test('a credit reward that is blank, zero or not a number', () => {
    expect(draftToPayload(d({ rewardValue: '' }))).toBeNull();
    expect(draftToPayload(d({ rewardValue: '0' }))).toBeNull();
    expect(draftToPayload(d({ rewardValue: 'free' }))).toBeNull();
    expect(draftToPayload(d({ rewardValue: '5' }))).not.toBeNull();
  });

  test('a pack or card reward with nothing picked', () => {
    expect(
      draftToPayload(d({ rewardType: 'pack', rewardValue: '  ' })),
    ).toBeNull();
    expect(
      draftToPayload(d({ rewardType: 'card', rewardValue: '' })),
    ).toBeNull();
  });
});

describe('scheduleOk', () => {
  test('both blank is valid — that is "runs until retired"', () => {
    expect(scheduleOk({ startsAt: '', endsAt: '' })).toBe(true);
  });

  test('either bound alone is valid', () => {
    expect(scheduleOk({ startsAt: '2026-09-01T00:00', endsAt: '' })).toBe(true);
    expect(scheduleOk({ startsAt: '', endsAt: '2026-09-01T00:00' })).toBe(true);
  });

  test('an end at or before the start is refused', () => {
    expect(
      scheduleOk({ startsAt: '2026-09-02T00:00', endsAt: '2026-09-01T00:00' }),
    ).toBe(false);
    expect(
      scheduleOk({ startsAt: '2026-09-01T00:00', endsAt: '2026-09-01T00:00' }),
    ).toBe(false);
    expect(
      scheduleOk({ startsAt: '2026-09-01T00:00', endsAt: '2026-09-02T00:00' }),
    ).toBe(true);
  });

  test('a half-typed datetime is refused, never treated as blank', () => {
    // Treating it as blank would publish a task the operator meant to schedule.
    expect(scheduleOk({ startsAt: 'not-a-date', endsAt: '' })).toBe(false);
    expect(toIso('not-a-date')).toBeNull();
    expect(toIso('')).toBeNull();
  });
});

describe('labelsOf', () => {
  test('uses the server labels when present', () => {
    expect(labelsOf(task()).reward).toBe('RM 5.00');
  });

  test('degrades to the raw type when the backend predates the field', () => {
    // A backend without `labels` is a normal mid-deploy state; reading through
    // it unguarded is what crashed the console on undefined.requirement.
    const stale = { ...task(), labels: undefined };
    expect(labelsOf(stale)).toEqual({
      requirement: 'checkin_days',
      reward: 'credit',
    });
  });
});

describe('windowLabel', () => {
  test('an unscheduled task reads "Always on", not an empty cell', () => {
    expect(windowLabel(task())).toBe('Always on');
  });

  test('one-sided windows render the open end as an em dash', () => {
    expect(
      windowLabel(task({ starts_at: '2026-09-01T00:00:00.000Z' })),
    ).toMatch(/ → —$/);
    expect(windowLabel(task({ ends_at: '2026-09-01T00:00:00.000Z' }))).toMatch(
      /^— → /,
    );
  });
});
