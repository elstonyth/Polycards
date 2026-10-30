import {
  claimLiveCycle,
  completeLiveCycle,
  createLiveState,
  validateLiveConfig,
} from '../automation-live';
import {
  LIVE_GOAL_MAX_CYCLES,
  liveRankTargetsToObserve,
  refreshLiveRankGoals,
} from '../automation-live-rank';
import { createHumanizedState, planHumanized } from '../automation-humanized';
import { validateRankTargets } from '../automation-rank';
import type { RankObservation } from '../automation-rank';
import type { LiveConfig, LiveCycle } from '../automation-live-types';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const config: LiveConfig = {
  packSlug: 'live-pack',
  customerIds: ['cus_a', 'cus_b'],
  intervalSeconds: 5,
  maxCyclesPerAccount: 1,
  rankTargets: [{ customerId: 'cus_a', period: 'weekly', targetRank: 1 }],
};
// Only the goal account in the run: the goal's own mechanics, with no
// ordinary draws from other accounts in between.
const goalOnly: LiveConfig = { ...config, customerIds: ['cus_a'] };
const running = (runConfig: LiveConfig = goalOnly) =>
  Object.assign(createLiveState(), {
    status: 'running' as const,
    config: runConfig,
    packPriceCents: 4500,
  });
const settle = (cycle: LiveCycle) => ({
  ...cycle,
  costCents: 4500,
  differenceCents: 0,
  bonusDifferenceCents: 0,
});
const observation = (now = NOW, held = false): RankObservation => ({
  periodKey: 'week-1',
  observedAt: now,
  customerId: 'cus_a',
  ownPulls: held ? 2 : 1,
  ownValueMyr: held ? 200 : 10,
  entries: held
    ? [
        { customerId: 'cus_a', pulls: 2, valueMyr: 200 },
        { customerId: 'external', pulls: 1, valueMyr: 100 },
      ]
    : [{ customerId: 'external', pulls: 1, valueMyr: 100 }],
});

it('accepts only distinct selected live customers and achievable Top N allocations', () => {
  const alltime = [{ ...config.rankTargets![0], period: 'alltime' as const }];
  expect(
    validateLiveConfig({ ...config, rankTargets: alltime }, config.customerIds)
      .rankTargets,
  ).toEqual(alltime);
  const [goal] = alltime;
  for (const rankTargets of [
    // Live goals stay on the all-time board only.
    config.rankTargets,
    [{ ...goal, customerId: 'cus_other' }],
    [goal, goal],
    [{ ...goal, targetRank: 11 }],
    [{ ...goal, mode: 'test' }],
    [goal, { ...goal, customerId: 'cus_b' }],
  ])
    expect(() =>
      validateLiveConfig({ ...config, rankTargets }, config.customerIds),
    ).toThrow();
  expect(() => validateRankTargets([{ mode: 'live' }])).toThrow();
});

it('never draws the goal account without fresh matching observations', () => {
  const state = running();
  expect(claimLiveCycle(state, NOW)).toBeNull();
  for (const value of [
    null,
    observation(NOW - 16000),
    { ...observation(), customerId: 'cus_b' },
  ]) {
    refreshLiveRankGoals(state, [value], NOW);
    expect(claimLiveCycle(state, NOW)).toBeNull();
    state.rankGoals![0].nextCheckAt = NOW;
  }
  refreshLiveRankGoals(state, [observation()], NOW);
  state.nextRunAt = NOW;
  expect(claimLiveCycle(state, NOW)?.customerId).toBe('cus_a');
});

it('confirms final settled draw twice before marking goal reached, surviving restart', () => {
  let state = running();
  refreshLiveRankGoals(state, [observation()], NOW);
  const cycle = claimLiveCycle(state, NOW)!;
  completeLiveCycle(
    state,
    { ...cycle, costCents: 4500, differenceCents: 0, bonusDifferenceCents: 0 },
    NOW + 1000,
  );
  expect(state.status).toBe('running');
  state = JSON.parse(JSON.stringify(state));
  refreshLiveRankGoals(state, [observation(NOW + 3000, true)], NOW + 3000);
  expect(claimLiveCycle(state, NOW + 3000)).toBeNull();
  expect(state.rankGoals![0].status.state).toBe('confirming');
  refreshLiveRankGoals(state, [observation(NOW + 5000, true)], NOW + 5000);
  expect(claimLiveCycle(state, NOW + 5000)).toBeNull();
  expect(state.status).toBe('completed');
  expect(state.rankGoals![0].status.state).toBe('secured');
  expect(state.cycles).toHaveLength(1);
});

it('keeps a goal account drawing past the per-account cap, up to its own ceiling', () => {
  const state = running();
  refreshLiveRankGoals(state, [observation()], NOW);
  const cycle = claimLiveCycle(state, NOW)!;
  completeLiveCycle(state, settle(cycle), NOW + 1);
  refreshLiveRankGoals(
    state,
    [{ ...observation(NOW + 6000), ownPulls: 2, ownValueMyr: 20 }],
    NOW + 6000,
  );
  expect(claimLiveCycle(state, NOW + 6000)?.customerId).toBe('cus_a');
  // At its ceiling the goal stops without claiming the rank was reached.
  const capped = running();
  capped.cycles = Array.from({ length: LIVE_GOAL_MAX_CYCLES }, (_, index) => ({
    id: `c${index}`,
    customerId: 'cus_a',
    startedAt: NOW,
    finishedAt: NOW,
    error: null,
  }));
  refreshLiveRankGoals(
    capped,
    [{ ...observation(), ownPulls: LIVE_GOAL_MAX_CYCLES }],
    NOW,
  );
  claimLiveCycle(capped, NOW);
  expect(capped.rankGoals![0].status.state).toBe('limited');
  expect(capped.status).toBe('completed');
});

it('stops on weekly rollover and unconfirmed own-pull updates without another draw', () => {
  for (const rollover of [true, false]) {
    const state = running();
    refreshLiveRankGoals(state, [observation()], NOW);
    const cycle = claimLiveCycle(state, NOW)!;
    completeLiveCycle(
      state,
      {
        ...cycle,
        costCents: 4500,
        differenceCents: 0,
        bonusDifferenceCents: 0,
      },
      NOW + 1,
    );
    refreshLiveRankGoals(
      state,
      [
        {
          ...observation(NOW + 31000),
          periodKey: rollover ? 'week-2' : 'week-1',
        },
      ],
      NOW + 31000,
    );
    expect(claimLiveCycle(state, NOW + 31000)).toBeNull();
    expect(state.rankGoals![0].status.state).toBe(
      rollover ? 'period_changed' : 'pending_timeout',
    );
    expect(state.cycles).toHaveLength(1);
  }
});

it('pushes a goal account past an owned account at its target boundary', () => {
  const state = running(config);
  state.config = {
    ...config,
    rankTargets: [
      { customerId: 'cus_a', period: 'weekly', targetRank: 2 },
      { customerId: 'cus_b', period: 'alltime', targetRank: 2 },
    ],
  };
  refreshLiveRankGoals(
    state,
    [
      {
        ...observation(),
        entries: [
          { customerId: 'external', pulls: 1, valueMyr: 100 },
          { customerId: 'cus_b', pulls: 1, valueMyr: 80 },
        ],
      },
      { ...observation(), customerId: 'cus_b', periodKey: 'alltime' },
    ],
    NOW,
  );
  expect(state.rankGoals![0].status.state).toBe('pushing');
  expect(claimLiveCycle(state, NOW)?.customerId).toBe('cus_a');
});

it('respects real-clock Humanized sleep even when a rank draw is eligible', () => {
  const state = running();
  state.config = {
    ...goalOnly,
    timingMode: 'humanized',
    humanizedRegion: 'mysg',
  };
  const now = Date.parse('2026-10-18T00:00:00Z');
  refreshLiveRankGoals(state, [observation(now)], now);
  expect(claimLiveCycle(state, now, () => 0.5)).toBeNull();
  expect(state.schedules![0].nextRunAt).toBeGreaterThan(now);
  expect(state.pending).toBeNull();
});

it('does not shorten the configured draw interval for a post-draw rank check', () => {
  const state = running();
  state.config = { ...goalOnly, intervalSeconds: 60, maxCyclesPerAccount: 2 };
  refreshLiveRankGoals(state, [observation()], NOW);
  const cycle = claimLiveCycle(state, NOW)!;
  completeLiveCycle(
    state,
    { ...cycle, costCents: 4500, differenceCents: 0, bonusDifferenceCents: 0 },
    NOW + 1000,
  );
  refreshLiveRankGoals(
    state,
    [{ ...observation(NOW + 3000), ownPulls: 2, ownValueMyr: 20 }],
    NOW + 3000,
  );
  expect(claimLiveCycle(state, NOW + 3000)).toBeNull();
  expect(state.pending).toBeNull();
  refreshLiveRankGoals(
    state,
    [{ ...observation(NOW + 61000), ownPulls: 2, ownValueMyr: 20 }],
    NOW + 61000,
  );
  expect(claimLiveCycle(state, NOW + 61000)?.customerId).toBe('cus_a');
});

it('refreshes dispatch-ready evidence across a weekly reset before the periodic check is due', () => {
  const state = running();
  state.config = { ...goalOnly, maxCyclesPerAccount: 2 };
  refreshLiveRankGoals(state, [observation()], NOW);
  state.nextDrawAt = NOW + 3000;
  expect(state.rankGoals![0].nextCheckAt).toBe(NOW + 15000);
  expect(liveRankTargetsToObserve(state, NOW + 2000)).toEqual([]);
  expect(liveRankTargetsToObserve(state, NOW + 3000)).toEqual(
    goalOnly.rankTargets,
  );
  refreshLiveRankGoals(
    state,
    [{ ...observation(NOW + 3000), periodKey: 'week-2' }],
    NOW + 3000,
  );
  expect(claimLiveCycle(state, NOW + 3000)).toBeNull();
  expect(state.rankGoals![0].status.state).toBe('period_changed');
});

it('rejects an observation that expires between its database read and cycle claim', () => {
  const state = running();
  refreshLiveRankGoals(
    state,
    [{ ...observation(), validUntil: NOW + 1000 }],
    NOW,
  );
  expect(claimLiveCycle(state, NOW + 1000)).toBeNull();
  expect(state.pending).toBeNull();
});

describe('accounts without a goal in a goal run', () => {
  // cus_a has the goal; cus_b (listed first) and cus_c draw ordinarily.
  const mixed: LiveConfig = {
    ...config,
    customerIds: ['cus_b', 'cus_a', 'cus_c'],
    timingMode: 'fixed',
  };

  it('keep drawing while the goal account has no fresh rank data', () => {
    const state = running(mixed);
    expect(claimLiveCycle(state, NOW)?.customerId).toBe('cus_b');
  });

  it('draw after an eligible goal account, even when listed before it', () => {
    const state = running(mixed);
    refreshLiveRankGoals(state, [observation()], NOW);
    expect(claimLiveCycle(state, NOW)?.customerId).toBe('cus_a');
  });

  it('share the run’s draw interval with the goal account', () => {
    const state = running(mixed);
    const first = claimLiveCycle(state, NOW)!;
    completeLiveCycle(state, settle(first), NOW + 1000);
    // Fixed 5 s interval from the settled draw.
    expect(claimLiveCycle(state, NOW + 3000)).toBeNull();
    expect(claimLiveCycle(state, NOW + 6000)?.customerId).toBe('cus_c');
  });

  it('keep the run going until they finish and every goal is done, then complete', () => {
    const state = running({ ...mixed, customerIds: ['cus_a', 'cus_b'] });
    refreshLiveRankGoals(state, [observation()], NOW);
    const goalDraw = claimLiveCycle(state, NOW)!;
    expect(goalDraw.customerId).toBe('cus_a');
    completeLiveCycle(state, settle(goalDraw), NOW + 1);
    // Two fresh checks confirm the goal; cus_b has not drawn yet.
    refreshLiveRankGoals(state, [observation(NOW + 3000, true)], NOW + 3000);
    refreshLiveRankGoals(state, [observation(NOW + 5000, true)], NOW + 5000);
    expect(state.rankGoals![0].status.state).toBe('secured');
    const other = claimLiveCycle(state, NOW + 6000)!;
    expect(other.customerId).toBe('cus_b');
    expect(state.status).toBe('running');
    completeLiveCycle(state, settle(other), NOW + 6001);
    expect(claimLiveCycle(state, NOW + 12000)).toBeNull();
    expect(state.status).toBe('completed');
  });

  it('end only the skipped account and keep the others drawing', () => {
    const state = running(mixed);
    const first = claimLiveCycle(state, NOW)!;
    completeLiveCycle(
      state,
      { ...first, skipped: 'Balance is below the cheapest pack.' },
      NOW + 1,
    );
    expect(state.status).toBe('running');
    expect(claimLiveCycle(state, NOW + 6000)?.customerId).toBe('cus_c');
  });

  it('wait behind a ready Humanized goal account that waited less', () => {
    const ready = (id: string) => {
      const humanized = createHumanizedState(id, 'mysg');
      let now = Date.parse('2026-10-18T04:00:00Z');
      for (let index = 0; index < 100; index++) {
        const plan = planHumanized(humanized, now, () => 0.5);
        if (plan.ready) break;
        now += plan.delayMs;
      }
      return { humanized, now };
    };
    const goal = ready('cus_a');
    const other = ready('cus_b');
    const now = Math.max(goal.now, other.now) + 60_000;
    goal.humanized.nextDrawAt = now - 1000;
    other.humanized.nextDrawAt = now - 50_000;
    const state = running({
      ...config,
      customerIds: ['cus_b', 'cus_a'],
      timingMode: 'humanized',
      humanizedRegion: 'mysg',
    });
    state.schedules = [
      {
        customerId: 'cus_b',
        humanized: other.humanized,
        nextRunAt: now - 50_000,
        waitReason: 'Within active session',
      },
      {
        customerId: 'cus_a',
        humanized: goal.humanized,
        nextRunAt: now - 1000,
        waitReason: 'Within active session',
      },
    ];
    refreshLiveRankGoals(state, [observation(now)], now);
    expect(claimLiveCycle(state, now, () => 0.5)?.customerId).toBe('cus_a');
  });
});
