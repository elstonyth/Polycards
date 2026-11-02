import { describe, expect, test } from 'vitest';
import {
  ANY,
  REQUIREMENT_TYPES,
  REWARD_LABEL,
  REWARD_TYPES,
  blankDraft,
  countApplies,
  draftChecks,
  draftFrom,
  draftMissing,
  draftToInput,
  draftToPayload,
  issueFixes,
  issueText,
  labelsOf,
  needsAnyConfirm,
  requirementLabel,
  scheduleOk,
  taskStatus,
  toIso,
  toLocalInput,
  windowLabel,
  type Draft,
} from './task-draft';
import type { AdminTaskDefinition } from '../../lib/admin-rest';

// What a complete form holds. blankDraft no longer holds any of it.
const filled = (): Draft => ({
  ...blankDraft(),
  reqType: 'checkin_days',
  reqN: '1',
  rewardType: 'credit',
  rewardValue: '5',
});

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
  tickets: 0,
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
    // Editing a saved top-up task must not reset it to RM 1.
    ['topup_myr', { type: 'topup_myr', amount_myr: 250 }],
  ];

  test.each(cases)('%s', (_name, requirement) => {
    const kind =
      requirement.type === 'checkin_days' ||
      requirement.type === 'rip_count' ||
      requirement.type === 'topup_myr'
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
  const d = (over: Partial<Draft>): Draft => ({ ...filled(), ...over });

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

describe('a Lucky Draw tickets reward', () => {
  const d = (over: Partial<Draft>): Draft => ({
    ...filled(),
    rewardType: 'tickets',
    rewardValue: '',
    ...over,
  });

  test('the form offers it', () => {
    expect(REWARD_TYPES).toContain('tickets');
    expect(REWARD_LABEL.tickets).toBe('Lucky Draw tickets');
  });

  test('the amount travels in tickets, the reward holds none', () => {
    expect(draftToPayload(d({ tickets: '50' }))).toMatchObject({
      reward: { type: 'tickets' },
      tickets: 50,
    });
  });

  test('a tickets reward paying nothing cannot be saved', () => {
    expect(draftToPayload(d({ tickets: '0' }))).toBeNull();
    expect(draftToPayload(d({ tickets: '' }))).toBeNull();
    expect(draftToPayload(d({ tickets: '1' }))).not.toBeNull();
  });

  test('a saved task round-trips', () => {
    const draft = draftFrom(
      task({ reward: { type: 'tickets' }, tickets: 50 }),
    );
    expect(draft).toMatchObject({
      rewardType: 'tickets',
      rewardValue: '',
      tickets: '50',
    });
    expect(draftToPayload(draft)).toMatchObject({
      reward: { type: 'tickets' },
      tickets: 50,
    });
  });
});

describe('Lucky Draw tickets (2026-10-24)', () => {
  const d = (over: Partial<Draft>): Draft => ({
    ...filled(),
    ...over,
  });

  test('a saved task opens with its tickets, as the text the input edits', () => {
    expect(draftFrom(task({ tickets: 50 })).tickets).toBe('50');
    expect(blankDraft().tickets).toBe('0');
  });

  test('the payload always carries tickets, so a save never drops them', () => {
    // The backend keeps a stored value only when the field is OMITTED.
    expect(draftToPayload(draftFrom(task({ tickets: 50 })))!.tickets).toBe(50);
    expect(draftToPayload(d({}))!.tickets).toBe(0);
  });

  test('a negative or fractional ticket count is refused', () => {
    expect(draftToPayload(d({ tickets: '-1' }))).toBeNull();
    expect(draftToPayload(d({ tickets: '1.5' }))).toBeNull();
    expect(draftToPayload(d({ tickets: '' }))).toBeNull();
    expect(draftToPayload(d({ tickets: 'lots' }))).toBeNull();
  });

  test('stops at the backend ceiling (10,000)', () => {
    expect(draftToPayload(d({ tickets: '10000' }))!.tickets).toBe(10_000);
    expect(draftToPayload(d({ tickets: '10001' }))).toBeNull();
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

describe('daily cadence (2026-10-06)', () => {
  test('daily and weekly offer the same repeating goals; achievements the lifetime ones', () => {
    expect(REQUIREMENT_TYPES.daily).toEqual(REQUIREMENT_TYPES.weekly);
    expect(REQUIREMENT_TYPES.daily).toContain('vault_pixel_count');
    expect(REQUIREMENT_TYPES.daily).not.toContain('reach_level');
  });

  test('a daily check-in is always one day, whatever the count box held', () => {
    const d: Draft = {
      ...filled(),
      kind: 'daily',
      reqN: '5',
      rewardValue: '1',
    };
    expect(countApplies(d)).toBe(false);
    expect(draftToPayload(d)!.requirement).toEqual({
      type: 'checkin_days',
      days: 1,
    });
  });

  test('a weekly check-in over seven days is refused before the round trip', () => {
    expect(
      draftToPayload({ ...filled(), kind: 'weekly', reqN: '8', rewardValue: '1' }),
    ).toBeNull();
    expect(
      draftToPayload({ ...filled(), kind: 'weekly', reqN: '7', rewardValue: '1' })!
        .requirement,
    ).toEqual({ type: 'checkin_days', days: 7 });
  });

  test('the goal wording follows the cadence', () => {
    expect(requirementLabel('daily', 'checkin_days')).toBe('Check in today');
    expect(requirementLabel('weekly', 'checkin_days')).toBe('Check in on N days');
    expect(requirementLabel('daily', 'vault_pixel_count')).toBe(
      'Pull N Pokémon (pixel) cards',
    );
    expect(requirementLabel('achievement', 'vault_pixel_count')).toBe(
      'Vault N Pokémon (pixel) cards',
    );
  });

  test('a daily task round-trips', () => {
    const requirement = { type: 'rip_count', count: 2, pack_id: 'bronze-pack' };
    expect(
      draftToPayload(draftFrom(task({ kind: 'daily', requirement })))!
        .requirement,
    ).toEqual(requirement);
  });
});

test('a hidden, stale count box never blocks a daily check-in save', () => {
  // Daily + rip_count, count cleared, then the goal switched to "Check in
  // today" (which hides the box): the save must still go through.
  expect(
    draftToPayload({
      ...filled(),
      kind: 'daily',
      reqType: 'checkin_days',
      reqN: '',
      rewardValue: '1',
    })!.requirement,
  ).toEqual({ type: 'checkin_days', days: 1 });
});

describe('taskStatus', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  test('switched off is retired, whatever the window', () => {
    expect(taskStatus(task({ active: false }), now)).toBe('retired');
  });
  test('no window is live', () => {
    expect(taskStatus(task(), now)).toBe('live');
  });
  test('inside the window is live', () => {
    expect(
      taskStatus(
        task({
          starts_at: '2026-10-05T00:00:00Z',
          ends_at: '2026-10-12T00:00:00Z',
        }),
        now,
      ),
    ).toBe('live');
  });
  test('a future start is upcoming', () => {
    expect(
      taskStatus(task({ starts_at: '2026-10-12T00:00:00Z' }), now),
    ).toBe('upcoming');
  });
  test('an end at or before now is ended (matches the backend <=)', () => {
    expect(taskStatus(task({ ends_at: '2026-10-04T15:59:00Z' }), now)).toBe(
      'ended',
    );
    expect(taskStatus(task({ ends_at: '2026-10-11T12:00:00Z' }), now)).toBe(
      'ended',
    );
  });
});

describe('topup_myr goal (2026-10-19)', () => {
  test('offered for every cadence, labelled in RM', () => {
    expect(REQUIREMENT_TYPES.daily).toContain('topup_myr');
    expect(REQUIREMENT_TYPES.weekly).toContain('topup_myr');
    expect(REQUIREMENT_TYPES.achievement).toContain('topup_myr');
    expect(requirementLabel('weekly', 'topup_myr')).toBe('Top up RM N');
  });

  test('sends amount_myr, not count', () => {
    const payload = draftToPayload({
      ...filled(),
      kind: 'daily',
      reqType: 'topup_myr',
      reqN: '100',
      rewardValue: '5',
    });
    expect(payload!.requirement).toEqual({ type: 'topup_myr', amount_myr: 100 });
  });
});


describe('a new task starts with nothing chosen (2026-11-02)', () => {
  // Each of these used to default to something valid, so leaving it alone saved
  // a rule nobody chose.
  test('a name and a reward alone cannot save', () => {
    const d: Draft = {
      ...blankDraft(),
      title: 'Pull 2 Eevee',
      rewardType: 'tickets',
      tickets: '20',
    };
    expect(draftToPayload(d)).toBeNull();
    expect(draftMissing(d).map((m) => m.step)).toEqual(['goal']);
  });

  test('a goal type alone leaves its count unset', () => {
    const d: Draft = {
      ...blankDraft(),
      reqType: 'vault_pixel_count',
      reqPixel: 'px_1',
      goal: { name: 'Mew', image: null, price: null },
      rewardType: 'tickets',
      tickets: '20',
    };
    expect(draftToPayload(d)).toBeNull();
    expect(draftMissing(d).map((m) => m.step)).toEqual(['n']);
  });

  test('a rip goal with no pack chosen is not "any pack"', () => {
    const d: Draft = {
      ...blankDraft(),
      reqType: 'rip_count',
      reqN: '10',
      rewardType: 'pack',
      rewardValue: 'bronze-pack',
      prize: { name: 'Bronze Pack', image: null, value: 300 },
    };
    expect(draftToPayload(d)).toBeNull();
    expect(draftMissing(d).map((m) => m.step)).toEqual(['target']);
    const any = { ...d, reqPack: ANY };
    expect(draftToPayload(any)!.requirement).toEqual({
      type: 'rip_count',
      count: 10,
      pack_id: null,
    });
    expect(needsAnyConfirm(any)).toBe(true);
    expect(needsAnyConfirm(d)).toBe(false);
  });

  test('the sentence lists what it still needs, in reading order', () => {
    expect(draftMissing(blankDraft()).map((m) => m.step)).toEqual([
      'goal',
      'reward',
    ]);
    expect(
      draftMissing({ ...blankDraft(), reqType: 'rip_count' }).map(
        (m) => m.step,
      ),
    ).toEqual(['n', 'target', 'reward']);
    expect(
      draftMissing({
        ...filled(),
        rewardType: 'pack',
        rewardValue: '',
      }).map((m) => m.step),
    ).toEqual(['value']);
    expect(draftMissing(filled())).toEqual([]);
  });

  test('the title comes from the rule, whatever the row was called', () => {
    const input = draftToInput(
      {
        ...filled(),
        title: 'Check in 1 days this week',
        reqType: 'checkin_days',
        reqN: '3',
      },
      'why',
    );
    expect(input).toMatchObject({
      title: 'Check in 3 days this week',
      reason: 'why',
    });
    expect(draftToInput(blankDraft(), 'why')).toBeNull();
  });
});

describe('draftFrom reads the count the goal type uses (2026-11-02)', () => {
  test('a stale days from an older goal does not win', () => {
    // Retire round-tripped through this, so a stale days could rewrite the count.
    const d = draftFrom(
      task({
        requirement: {
          type: 'vault_pixel_count',
          days: 1,
          count: 2,
          pixel_pokemon_id: 'px',
        },
      }),
    );
    expect(d.reqN).toBe('2');
    expect(draftToPayload(d)!.requirement).toEqual({
      type: 'vault_pixel_count',
      count: 2,
      pixel_pokemon_id: 'px',
    });
  });
});

describe('draftChecks', () => {
  const week = [
    task({
      id: 'day1',
      requirement: { type: 'checkin_days', days: 1 },
      labels: { requirement: 'Check in on 1 day', reward: '5 Lucky Draw tickets' },
    }),
    task({
      id: 'mew',
      requirement: {
        type: 'vault_pixel_count',
        count: 2,
        pixel_pokemon_id: 'mew',
      },
      labels: { requirement: 'Pull 2 × Mew', reward: '20 tickets' },
    }),
  ];

  test('a check-in day already taken says so', () => {
    const [check] = draftChecks({ ...filled(), reqN: '1' }, week);
    expect(check.tone).toBe('warn');
    expect(check.text).toContain('Day 1 already pays 5 Lucky Draw tickets');
  });

  test('a free day says so too, and a row does not clash with itself', () => {
    expect(draftChecks({ ...filled(), reqN: '4' }, week)[0]).toEqual({
      tone: 'ok',
      text: 'Day 4 has nothing else on it.',
    });
    expect(
      draftChecks({ ...filled(), id: 'day1', reqN: '1' }, week)[0].tone,
    ).toBe('ok');
  });

  test('the same goal twice in a week says so', () => {
    const [check] = draftChecks(
      {
        ...filled(),
        reqType: 'vault_pixel_count',
        reqN: '2',
        reqPixel: 'mew',
      },
      week,
    );
    expect(check.tone).toBe('warn');
    expect(check.text).toContain('Pull 2 × Mew');
  });

  test('a reward worth more than the goal costs warns', () => {
    const checks = draftChecks(
      {
        ...filled(),
        reqType: 'rip_count',
        reqN: '4',
        reqPack: ANY,
        rewardType: 'pack',
        rewardValue: 'silver-pack',
        goal: { name: null, image: null, price: 20 },
        prize: { name: 'Silver Pack', image: null, value: 240 },
      },
      [],
    );
    expect(checks[0].tone).toBe('warn');
    expect(checks[0].text).toContain('RM 80');
    expect(checks[0].text).toContain('RM 240');
    expect(checks[0].text).toContain('300%');
  });

  test('a normal give-back reads as fine', () => {
    const checks = draftChecks(
      {
        ...filled(),
        reqType: 'rip_count',
        reqN: '10',
        reqPack: 'bronze-pack',
        rewardType: 'pack',
        rewardValue: 'bronze-pack',
        goal: { name: 'Bronze Pack', image: null, price: 300 },
        prize: { name: 'Bronze Pack', image: null, value: 300 },
      },
      [],
    );
    expect(checks[0].tone).toBe('ok');
    expect(checks[0].text).toContain('10%');
  });

  test('editing a claimed task says the claims stay', () => {
    const last = draftChecks(filled(), [], 48).at(-1)!;
    expect(last.text).toContain('48 already claimed');
  });
});

describe('mismatch fixes', () => {
  const silver = {
    slug: 'silver-pack',
    title: 'Silver Pack',
    image: '/s.webp',
    price: 600,
    prize_type: 'cards',
    status: 'active' as const,
    in_stock: true,
  };
  const gold = { ...silver, slug: 'gold-pack', title: 'Gold Pack', price: 1200 };
  const goldCapsule = {
    ...silver,
    slug: 'gold-capsule',
    title: 'Gold Capsule',
    price: 40,
    prize_type: 'tickets',
  };
  const goldRush = { ...silver, slug: 'gold-rush', title: 'Gold Rush', status: 'draft' as const };
  const anyRow = task({
    title: 'Rip 5 Gold Free 1 Silver',
    requirement: { type: 'rip_count', count: 5, pack_id: null },
    reward: { type: 'pack', pack_id: 'silver-pack' },
    claims: 7,
    view: {
      goal_name: null,
      goal_image: null,
      goal_price_myr: 20,
      reward_name: 'Silver Pack',
      reward_image: null,
      reward_value_myr: 600,
    },
  });
  const issue = { kind: 'any', says: 'gold' } as const;

  test('any pack: says the cost, and can narrow to the pack the name means', () => {
    const text = issueText(anyRow, issue);
    expect(text.headline).toContain('says Gold');
    expect(text.detail).toContain('5 × RM 20 = RM 100');
    expect(text.detail).toContain('It pays RM 600');
    expect(text.detail).toContain('7 claimed');

    const [only, keep] = issueFixes(anyRow, issue, [goldCapsule, gold, silver]);
    expect(only.label).toBe('Make it Gold only');
    const fixed = only.patch!(draftFrom(anyRow));
    expect(draftToPayload(fixed)!.requirement).toEqual({
      type: 'rip_count',
      count: 5,
      pack_id: 'gold-pack',
    });
    expect(draftToInput(fixed, 'x')!.title).toBe('Rip 5 Gold, free 1 Silver');
    expect(keep.label).toBe('Any pack is right');
    expect(draftToInput(draftFrom(anyRow), 'x')!.title).toBe(
      'Rip any 5 packs, free 1 Silver',
    );
  });

  test('any pack: only a pack on sale, and only one, gets the one-click fix', () => {
    expect(issueFixes(anyRow, issue, [goldCapsule])[0].action).toBe('open');
    expect(issueFixes(anyRow, issue, [goldRush])[0].action).toBe('open');
    expect(
      issueFixes(anyRow, issue, [{ ...gold, in_stock: false }])[0].action,
    ).toBe('open');
    expect(
      issueFixes(anyRow, issue, [gold, { ...gold, slug: 'gold-2' }])[0].action,
    ).toBe('open');
  });

  const mew = task({
    title: 'Pull 2 Mew (Graded or Ungraded)',
    requirement: {
      type: 'vault_pixel_count',
      count: 1,
      pixel_pokemon_id: 'mew',
    },
    reward: { type: 'tickets' },
    tickets: 20,
    view: {
      goal_name: 'Mew',
      goal_image: null,
      goal_price_myr: null,
      reward_name: null,
      reward_image: null,
      reward_value_myr: null,
    },
  });

  test('count: either the rule moves or the name does', () => {
    const [change, rename] = issueFixes(mew, { kind: 'count', says: 2 });
    expect(draftToInput(change.patch!(draftFrom(mew)), 'x')).toMatchObject({
      title: 'Pull 2 Mew (Graded or Ungraded)',
      requirement: { count: 2 },
    });
    expect(draftToInput(rename.patch!(draftFrom(mew)), 'x')!.title).toBe(
      'Pull 1 Mew (Graded or Ungraded)',
    );
  });

  test('"the rule is right" restores the rule, whatever was typed since', () => {
    const [, rename] = issueFixes(mew, { kind: 'count', says: 2 });
    const typed = { ...draftFrom(mew), reqN: '7' };
    expect(draftToPayload(rename.patch!(typed))!.requirement).toMatchObject({
      count: 1,
    });
  });

  test('"Change rule to N" is only offered when the rule can be N', () => {
    const daily = task({
      kind: 'daily',
      title: 'Check in 2 days this week',
      requirement: { type: 'checkin_days', days: 1 },
    });
    expect(
      issueFixes(daily, { kind: 'count', says: 2 }).map((f) => f.label),
    ).not.toContain('Change rule to 2');
    const weekly = task({
      title: 'Check in 8 days',
      requirement: { type: 'checkin_days', days: 1 },
    });
    expect(
      issueFixes(weekly, { kind: 'count', says: 8 }).map((f) => f.label),
    ).not.toContain('Change rule to 8');
  });

  test('wrong goal type: open it, or retire it', () => {
    const wrongGoal = task({
      title: 'Pull 2 Eevee',
      requirement: { type: 'checkin_days', days: 1 },
    });
    expect(
      issueFixes(wrongGoal, { kind: 'goal', says: 'Pull' }).map((f) => f.action),
    ).toEqual(['open', 'retire']);
    expect(issueText(wrongGoal, { kind: 'goal', says: 'Pull' }).headline).toContain(
      'says Pull',
    );
  });

  test('wrong reward in the name: open it, or rename', () => {
    const fixes = issueFixes(mew, { kind: 'reward', says: 'RM 100' });
    expect(fixes.map((f) => f.action)).toEqual(['open', 'patch']);
    expect(issueText(mew, { kind: 'reward', says: 'RM 100' }).headline).toContain(
      'says RM 100',
    );
  });

  test('with no claims field, it says nothing about claims', () => {
    const stale = { ...mew };
    delete stale.claims;
    expect(issueText(stale, { kind: 'count', says: 2 }).detail).toBe('');
  });
});

describe('a name is never written for something the form cannot name', () => {
  // No view means a backend mid-deploy, or a pack, Pokémon or card since deleted.
  // Writing a name anyway would call a Diamond-only rule "Rip any 2 packs".
  const rip: Draft = {
    ...filled(),
    reqType: 'rip_count',
    reqN: '2',
    reqPack: 'diamond-pack',
  };

  test('a named pack with no name to hand must be picked again', () => {
    expect(draftMissing(rip)).toEqual([
      { step: 'target', label: 're-pick the pack' },
    ]);
    expect(draftToInput(rip, 'x')).toBeNull();
    expect(
      draftToInput(
        { ...rip, goal: { name: 'Diamond Pack', image: null, price: 5000 } },
        'x',
      )!.title,
    ).toBe('Rip 2 Diamond, free RM 5 bonus credit');
  });

  test('so must a named Pokémon', () => {
    const pull: Draft = {
      ...filled(),
      reqType: 'vault_pixel_count',
      reqN: '2',
      reqPixel: 'px_151',
    };
    expect(draftMissing(pull)).toEqual([
      { step: 'target', label: 're-pick the Pokémon' },
    ]);
    expect(draftToInput(pull, 'x')).toBeNull();
  });

  test('so must a named reward', () => {
    expect(
      draftMissing({
        ...filled(),
        rewardType: 'pack',
        rewardValue: 'gold-pack',
      }).map((m) => m.label),
    ).toEqual(['re-pick the pack to give']);
    expect(
      draftMissing({
        ...filled(),
        rewardType: 'card',
        rewardValue: 'umbreon-92',
      }).map((m) => m.label),
    ).toEqual(['re-pick the card']);
  });

  test('"any" has no name and needs none', () => {
    expect(draftMissing({ ...rip, reqPack: ANY })).toEqual([]);
    expect(draftToInput({ ...rip, reqPack: ANY }, 'x')!.title).toBe(
      'Rip any 2 packs, free RM 5 bonus credit',
    );
  });

  test('a row with no view opens asking for its target, not renaming it', () => {
    const d = draftFrom(
      task({
        requirement: { type: 'rip_count', count: 2, pack_id: 'diamond-pack' },
      }),
    );
    expect(draftMissing(d).map((m) => m.step)).toEqual(['target']);
    // Retire and the round trip don't need a name, so they still work.
    expect(draftToPayload(d)).not.toBeNull();
  });
});

describe('what the backend refuses is refused here first', () => {
  const rule = (over: Partial<Draft>): Draft => ({ ...filled(), ...over });

  test.each<[string, Partial<Draft>]>([
    ['level over 100', { kind: 'achievement', reqType: 'reach_level', reqN: '101' }],
    ['a top-up over RM 100,000', { reqType: 'topup_myr', reqN: '100001' }],
    ['credit over RM 10,000', { rewardValue: '10001' }],
    ['credit finer than a sen', { rewardValue: '5.555' }],
    ['credit of a thousandth', { rewardValue: '0.001' }],
    ['a fractional top-up', { reqType: 'topup_myr', reqN: '1.5' }],
  ])('%s', (_name, over) => {
    expect(draftToPayload(rule(over))).toBeNull();
    expect(draftMissing(rule(over)).length).toBeGreaterThan(0);
  });

  test.each<[string, Partial<Draft>]>([
    ['level 100', { kind: 'achievement', reqType: 'reach_level', reqN: '100' }],
    ['a top-up of RM 100,000', { reqType: 'topup_myr', reqN: '100000' }],
    ['credit of RM 10,000', { rewardValue: '10000' }],
    ['credit in whole sen', { rewardValue: '5.55' }],
  ])('%s is fine', (_name, over) => {
    expect(draftToPayload(rule(over))).not.toBeNull();
    expect(draftMissing(rule(over))).toEqual([]);
  });

  test('a reward type this form does not know is not sent as a card', () => {
    expect(
      draftToPayload({
        ...filled(),
        rewardType: 'mystery' as Draft['rewardType'],
        rewardValue: 'x',
      }),
    ).toBeNull();
  });
});

describe('a save that would fail always says why', () => {
  const says = (over: Partial<Draft>) =>
    draftMissing({ ...filled(), ...over }).map((m) => m.label);

  test.each<[Partial<Draft>]>([
    [{ rewardValue: '0.00' }],
    [{ rewardValue: '00' }],
    [{ rewardValue: '-5' }],
    [{ tickets: '' }],
    [{ tickets: '-1' }],
    [{ tickets: '1.5' }],
    [{ tickets: '10001' }],
    [{ rewardType: 'tickets', rewardValue: '', tickets: '1.5' }],
    [{ rewardType: 'tickets', rewardValue: '', tickets: '10001' }],
    [{ reqN: '8' }],
  ])('%j', (over) => {
    expect(says(over).length).toBeGreaterThan(0);
    expect(draftToInput({ ...filled(), ...over }, 'x')).toBeNull();
  });

  test('tickets on top point at where they live', () => {
    expect(says({ tickets: '1.5' })[0]).toContain('More options');
  });

  test('a name past what the backend allows asks for something shorter', () => {
    const long: Draft = {
      ...filled(),
      reqType: 'rip_count',
      reqN: '2',
      reqPack: 'long',
      goal: { name: 'x'.repeat(130), image: null, price: 5 },
    };
    expect(draftMissing(long).at(-1)!.label).toContain('shorter');
    expect(draftToInput(long, 'x')).toBeNull();
  });
});

describe('a saved window survives a save to the second', () => {
  const windowed = task({
    starts_at: '2026-11-01T16:00:30.000Z',
    ends_at: '2026-11-08T15:59:59.000Z',
  });

  test('untouched, it goes back exactly', () => {
    expect(draftToInput(draftFrom(windowed), 'x')).toMatchObject({
      starts_at: '2026-11-01T16:00:30.000Z',
      ends_at: '2026-11-08T15:59:59.000Z',
    });
  });

  test('changed, the new value is used', () => {
    const d = { ...draftFrom(windowed), endsAt: '' };
    expect(draftToInput(d, 'x')).toMatchObject({
      starts_at: '2026-11-01T16:00:30.000Z',
      ends_at: null,
    });
  });

  test('toLocalInput and toIso round-trip to the minute', () => {
    const at = '2026-11-01T16:00:00.000Z';
    expect(toIso(toLocalInput(new Date(at)))).toBe(at);
    expect(toLocalInput(new Date('garbage'))).toBe('');
  });
});

describe('the same goal twice in a week', () => {
  const week = [
    task({
      id: 'any',
      requirement: { type: 'rip_count', count: 10, pack_id: null },
      labels: { requirement: 'Rip 10 packs', reward: 'Free rip' },
    }),
    task({
      id: 'top',
      requirement: { type: 'topup_myr', amount_myr: 100 },
      labels: { requirement: 'Top up RM 100', reward: 'RM 10' },
    }),
  ];

  test('catches two any-pack rips and two equal top-ups', () => {
    expect(
      draftChecks(
        { ...filled(), reqType: 'rip_count', reqN: '10', reqPack: ANY },
        week,
      )[0].text,
    ).toContain('already has this goal');
    expect(
      draftChecks({ ...filled(), reqType: 'topup_myr', reqN: '100' }, week)[0]
        .text,
    ).toContain('already has this goal');
  });

  test('a daily or achievement task is not the same goal as a weekly one', () => {
    expect(
      draftChecks(
        { ...filled(), kind: 'daily', reqType: 'topup_myr', reqN: '100' },
        week,
      ).map((c) => c.text),
    ).not.toContainEqual(expect.stringContaining('already has this goal'));
  });

  test('a pack players cannot rip is said out loud', () => {
    const [check] = draftChecks(
      {
        ...filled(),
        reqType: 'rip_count',
        reqN: '2',
        reqPack: 'draft-pack',
        goal: { name: 'Draft Pack', image: null, price: 5, buyable: false },
      },
      [],
    );
    expect(check.tone).toBe('warn');
    expect(check.text).toContain("can't rip");
  });
});
