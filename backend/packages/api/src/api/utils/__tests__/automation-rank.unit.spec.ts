import {
  createRankRuntime,
  evaluateRank,
  markRankDispatched,
  persistedRankStatus,
  validateRankTargets,
  type RankObservation,
} from '../automation-rank';
import type { AutomationRankTarget } from '../automation-types';

const NOW = Date.parse('2026-10-17T16:00:00.000Z');
const target = (
  change: Partial<AutomationRankTarget> = {},
): AutomationRankTarget => ({
  profileId: 'profile-1',
  period: 'weekly',
  mode: 'test',
  goal: 'reach',
  targetRank: 1,
  secureBufferMyr: 20,
  threatBufferMyr: 5,
  maxCycles: 10,
  maxSpendMyr: 100,
  maxDurationMinutes: 10,
  ...change,
});
const observation = (
  change: Partial<RankObservation> = {},
): RankObservation => ({
  periodKey: '2026-10-12T00:00:00+08:00',
  observedAt: NOW,
  customerId: 'local',
  ownPulls: 1,
  ownValueMyr: 50,
  entries: [
    { customerId: 'external', pulls: 5, valueMyr: 200 },
    { customerId: 'local', pulls: 1, valueMyr: 50 },
  ],
  ...change,
});
const options = (
  now = NOW,
  change: Partial<Parameters<typeof evaluateRank>[2]> = {},
) => ({
  now,
  completedCycles: 0,
  spentMyr: 0,
  maxCycles: 10,
  nextCostMyr: 10,
  ownedCustomerIds: new Set(['local']),
  ...change,
});
const held = (at: number, valueMyr = 250, competitor = 200): RankObservation =>
  observation({
    observedAt: at,
    ownValueMyr: valueMyr,
    entries: [
      { customerId: 'local', pulls: 1, valueMyr },
      { customerId: 'external', pulls: 5, valueMyr: competitor },
    ],
  });

it('accepts finite distinct profiles and independent weekly/all-time targets', () => {
  expect(validateRankTargets(undefined)).toEqual([]);
  const inputs = [
    target(),
    target({ profileId: 'profile-2', period: 'alltime' }),
  ];
  const parsed = validateRankTargets(inputs);
  expect(parsed).toEqual(inputs);
  expect(parsed[0]).not.toBe(inputs[0]);
});

it.each([
  { targetRank: 0 },
  { targetRank: 11 },
  { targetRank: 1.5 },
  { targetRank: '1' },
  { maxCycles: 0 },
  { maxCycles: 11 },
  { maxCycles: Infinity },
  { maxSpendMyr: 9.99 },
  { maxSpendMyr: 100.01 },
  { maxSpendMyr: NaN },
  { maxSpendMyr: 10.001 },
  { maxDurationMinutes: 0 },
  { maxDurationMinutes: 61 },
  { maxDurationMinutes: 1.5 },
  { secureBufferMyr: -1 },
  { threatBufferMyr: 21 },
  { profileId: '../profile' },
  { mode: 'live' },
  { mode: ['test'] },
  { period: ['weekly'] },
  { goal: ['reach'] },
  { accountPassword: 'never-import-secrets' },
])('rejects invalid/unrecognized rank settings: %j', (change) => {
  expect(() => validateRankTargets([{ ...target(), ...change }])).toThrow();
});

it('rejects duplicate profile goals even across boards and impossible capacity before execution', () => {
  expect(() =>
    validateRankTargets([target(), target({ period: 'alltime' })]),
  ).toThrow();
  expect(() =>
    validateRankTargets([target(), target({ profileId: 'profile-2' })]),
  ).toThrow(/conflict/);
  expect(() =>
    validateRankTargets(
      Array.from({ length: 11 }, (_, i) =>
        target({ profileId: `p-${i}`, targetRank: 10 }),
      ),
    ),
  ).toThrow(/conflict/);
  expect(
    validateRankTargets(
      Array.from({ length: 10 }, (_, i) =>
        target({ profileId: `p-${i}`, targetRank: 10 }),
      ),
    ),
  ).toHaveLength(10);
  expect(
    validateRankTargets([
      target(),
      target({ profileId: 'profile-2', mode: 'monitor' }),
    ]),
  ).toHaveLength(2);
});

it.each(['monitor', 'shadow'] as const)(
  '%s reports one decision and never authorizes a draw',
  (mode) => {
    const runtime = createRankRuntime(target({ mode }), NOW);
    expect(evaluateRank(runtime, observation(), options())).toMatchObject({
      draw: false,
      done: true,
    });
    expect(runtime.status.eligible).toBe(false);
    expect(runtime.status.wouldDraw).toBe(mode === 'shadow');
    expect(() => markRankDispatched(runtime, NOW)).toThrow(/eligible/);
  },
);

it('checks next cost before dispatch, allowing exact cap and blocking one-cent overspend', () => {
  const exact = createRankRuntime(target({ maxSpendMyr: 20 }), NOW);
  expect(
    evaluateRank(exact, observation(), options(NOW, { spentMyr: 10 })),
  ).toMatchObject({ draw: true });
  const excess = createRankRuntime(target({ maxSpendMyr: 20 }), NOW);
  expect(
    evaluateRank(excess, observation(), options(NOW, { spentMyr: 10.01 })),
  ).toMatchObject({ draw: false, done: true });
  expect(excess.status.state).toBe('limited');
});

it.each([
  { targetCycles: 2, batchCycles: 10, completed: 2 },
  { targetCycles: 10, batchCycles: 2, completed: 2 },
])(
  'respects both independent cycle ceilings: %j',
  ({ targetCycles, batchCycles, completed }) => {
    const runtime = createRankRuntime(target({ maxCycles: targetCycles }), NOW);
    expect(
      evaluateRank(
        runtime,
        observation(),
        options(NOW, { maxCycles: batchCycles, completedCycles: completed }),
      ),
    ).toMatchObject({ draw: false, done: true });
  },
);

it('does not invent rank outside visible entries and computes the gap in exact cents', () => {
  const runtime = createRankRuntime(target(), NOW);
  expect(
    evaluateRank(
      runtime,
      observation({
        ownValueMyr: 100.1,
        entries: [{ customerId: 'external', pulls: 5, valueMyr: 100.2 }],
      }),
      options(),
    ),
  ).toMatchObject({ draw: true, done: false });
  expect(runtime.status).toMatchObject({
    currentRank: null,
    gapMyr: 0.11,
    leadMyr: -0.1,
  });
});

it('requires own pull count AND value update; competitor rank changes cannot clear pending', () => {
  const runtime = createRankRuntime(target(), NOW);
  evaluateRank(runtime, observation(), options());
  markRankDispatched(runtime, NOW);
  expect(() => markRankDispatched(runtime, NOW)).toThrow(/eligible/);
  const rankChange = observation({
    observedAt: NOW + 2000,
    entries: [
      { customerId: 'new-external', pulls: 20, valueMyr: 400 },
      { customerId: 'external', pulls: 5, valueMyr: 200 },
      { customerId: 'local', pulls: 1, valueMyr: 50 },
    ],
  });
  expect(evaluateRank(runtime, rankChange, options(NOW + 2000))).toMatchObject({
    draw: false,
    done: false,
  });
  expect(runtime.status.state).toBe('pending');
  for (const change of [{ ownPulls: 2 }, { ownValueMyr: 60 }]) {
    evaluateRank(
      runtime,
      observation({ ...change, observedAt: NOW + 4000 }),
      options(NOW + 4000),
    );
    expect(runtime.pending).not.toBeNull();
    expect(runtime.status.eligible).toBe(false);
  }
  expect(
    evaluateRank(
      runtime,
      observation({ observedAt: NOW + 6000, ownPulls: 2, ownValueMyr: 60 }),
      options(NOW + 6000),
    ),
  ).toMatchObject({ draw: true, done: false });
  expect(runtime.pending).toBeNull();
});

it.each([
  ['weekly', 30_000],
  ['alltime', 45_000],
] as const)(
  '%s confirmation timeout stops instead of blindly retrying',
  (period, timeout) => {
    const runtime = createRankRuntime(target({ period }), NOW);
    const periodKey =
      period === 'alltime' ? 'ALL_TIME' : observation().periodKey;
    evaluateRank(runtime, observation({ periodKey }), options());
    markRankDispatched(runtime, NOW);
    expect(
      evaluateRank(
        runtime,
        observation({ periodKey, observedAt: NOW + timeout - 1 }),
        options(NOW + timeout - 1),
      ),
    ).toMatchObject({ draw: false, done: false });
    expect(
      evaluateRank(
        runtime,
        observation({ periodKey, observedAt: NOW + timeout }),
        options(NOW + timeout),
      ),
    ).toMatchObject({ draw: false, done: true });
    expect(runtime.status.state).toBe('pending_timeout');
  },
);

it('weekly rollover stops before old pending values can confirm a new week', () => {
  const runtime = createRankRuntime(target(), NOW);
  evaluateRank(runtime, observation(), options());
  markRankDispatched(runtime, NOW);
  expect(
    evaluateRank(
      runtime,
      observation({
        observedAt: NOW + 2000,
        periodKey: 'next-week',
        ownPulls: 2,
        ownValueMyr: 60,
      }),
      options(NOW + 2000),
    ),
  ).toMatchObject({ draw: false, done: true });
  expect(runtime.status.state).toBe('period_changed');
});

it('reach requires two distinct observations and finishes once target and buffer are secured', () => {
  const runtime = createRankRuntime(target(), NOW);
  expect(evaluateRank(runtime, held(NOW), options())).toMatchObject({
    draw: false,
    done: false,
  });
  expect(evaluateRank(runtime, held(NOW), options(NOW + 1000))).toMatchObject({
    draw: false,
    done: false,
  });
  expect(
    evaluateRank(runtime, held(NOW + 2000), options(NOW + 2000)),
  ).toMatchObject({ draw: false, done: true });
  expect(runtime.status).toMatchObject({
    state: 'secured',
    currentRank: 1,
    leadMyr: 50,
  });
});

it('maintain confirms a rank loss before defending and suppresses flapping', () => {
  const runtime = createRankRuntime(target({ goal: 'maintain' }), NOW);
  evaluateRank(runtime, held(NOW), options());
  evaluateRank(runtime, held(NOW + 2000), options(NOW + 2000));
  expect(runtime.status.state).toBe('holding');
  expect(
    evaluateRank(
      runtime,
      observation({ observedAt: NOW + 4000 }),
      options(NOW + 4000),
    ),
  ).toMatchObject({ draw: false });
  expect(
    evaluateRank(
      runtime,
      observation({ observedAt: NOW + 4000 }),
      options(NOW + 5000),
    ),
  ).toMatchObject({ draw: false });
  evaluateRank(runtime, held(NOW + 6000), options(NOW + 6000));
  expect(runtime.lostSamples).toBe(0);
  evaluateRank(
    runtime,
    observation({ observedAt: NOW + 8000 }),
    options(NOW + 8000),
  );
  expect(
    evaluateRank(
      runtime,
      observation({ observedAt: NOW + 10_000 }),
      options(NOW + 10_000),
    ),
  ).toMatchObject({ draw: true, done: false });
  expect(runtime.status.state).toBe('defending');
});

it('maintain holds above threat buffer and becomes eligible at its threshold', () => {
  const runtime = createRankRuntime(target({ goal: 'maintain' }), NOW);
  evaluateRank(runtime, held(NOW, 210), options());
  expect(
    evaluateRank(runtime, held(NOW + 2000, 210), options(NOW + 2000)),
  ).toMatchObject({ draw: false, done: false });
  expect(
    evaluateRank(runtime, held(NOW + 4000, 205), options(NOW + 4000)),
  ).toMatchObject({ draw: true, done: false });
  expect(runtime.status.state).toBe('threatened');
});

it('held targets exclude owned accounts from threats and buffers', () => {
  const runtime = createRankRuntime(target(), NOW);
  const obs = held(NOW);
  obs.entries.splice(1, 0, {
    customerId: 'owned-peer',
    pulls: 2,
    valueMyr: 249,
  });
  const opts = options(NOW, {
    ownedCustomerIds: new Set(['local', 'owned-peer']),
  });
  evaluateRank(runtime, obs, opts);
  expect(
    evaluateRank(
      runtime,
      { ...obs, observedAt: NOW + 2000 },
      { ...opts, now: NOW + 2000 },
    ),
  ).toMatchObject({ draw: false, done: true });
  expect(runtime.status.leadMyr).toBe(50);
});

it('below-target account pushes past an owned account at the target boundary; monitor mode only reports it', () => {
  const owned = options(NOW, {
    ownedCustomerIds: new Set(['local', 'external']),
  });
  const runtime = createRankRuntime(target(), NOW);
  expect(evaluateRank(runtime, observation(), owned)).toMatchObject({
    draw: true,
    done: false,
  });
  expect(runtime.status.state).toBe('pushing');
  const monitor = createRankRuntime(target({ mode: 'monitor' }), NOW);
  expect(evaluateRank(monitor, observation(), owned)).toMatchObject({
    draw: false,
  });
  expect(monitor.status.state).toBe('conflict');
});

it('missing external cutoff is explicitly unknown rather than a fabricated zero-value competitor', () => {
  const runtime = createRankRuntime(target(), NOW);
  const obs = held(NOW);
  obs.entries = obs.entries.slice(0, 1);
  evaluateRank(runtime, obs, options());
  expect(
    evaluateRank(
      runtime,
      { ...obs, observedAt: NOW + 2000 },
      options(NOW + 2000),
    ),
  ).toMatchObject({ draw: false, done: true });
  expect(runtime.status).toMatchObject({ leadMyr: null, gapMyr: null });
  expect(runtime.status.reason).toContain('no visible external competitor');
});

it.each([
  null,
  observation({ observedAt: NOW - 15_001 }),
  observation({ observedAt: NOW + 1 }),
  observation({ ownValueMyr: NaN }),
  observation({ ownPulls: -1 }),
  observation({
    entries: [{ customerId: 'external', pulls: 1, valueMyr: Infinity }],
  }),
])('holds on stale, future, missing or malformed observations', (obs) => {
  const runtime = createRankRuntime(target(), NOW);
  expect(evaluateRank(runtime, obs, options())).toMatchObject({
    draw: false,
    done: false,
  });
  expect(runtime.status.state).toBe('stale');
});

it('duration is a hard wall-clock bound even when data remains unavailable', () => {
  const runtime = createRankRuntime(target({ maxDurationMinutes: 1 }), NOW);
  expect(evaluateRank(runtime, null, options(NOW + 59_999))).toMatchObject({
    draw: false,
    done: false,
  });
  expect(evaluateRank(runtime, null, options(NOW + 60_000))).toMatchObject({
    draw: false,
    done: true,
  });
  expect(runtime.status.stopReason).toMatch(/duration/);
});

it('event history deduplicates unchanged decisions and persisted status excludes extra fields', () => {
  const runtime = createRankRuntime(target(), NOW);
  evaluateRank(runtime, observation(), options());
  evaluateRank(runtime, observation(), options());
  expect(runtime.status.events).toHaveLength(1);
  expect(
    persistedRankStatus({ ...runtime.status, secret: 'not-a-public-field' }),
  ).toEqual(runtime.status);
  expect(
    persistedRankStatus({
      ...runtime.status,
      events: [{ at: 'bad', type: 'pushing', message: 'invalid' }],
    }),
  ).toBeUndefined();
  expect(
    persistedRankStatus({ ...runtime.status, currentRank: Infinity }),
  ).toBeUndefined();
});
