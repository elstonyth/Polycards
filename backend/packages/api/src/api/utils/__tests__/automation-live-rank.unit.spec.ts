import {
  claimLiveCycle,
  completeLiveCycle,
  createLiveState,
  validateLiveConfig,
} from '../automation-live';
import {
  liveRankTargetsToObserve,
  refreshLiveRankGoals,
} from '../automation-live-rank';
import { validateRankTargets } from '../automation-rank';
import type { RankObservation } from '../automation-rank';
import type { LiveConfig } from '../automation-live-types';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const config: LiveConfig = {
  packSlug: 'live-pack',
  customerIds: ['cus_a', 'cus_b'],
  intervalSeconds: 5,
  maxCyclesPerAccount: 1,
  rankTargets: [{ customerId: 'cus_a', period: 'weekly', targetRank: 1 }],
};
const running = () =>
  Object.assign(createLiveState(), {
    status: 'running' as const,
    config,
    packPriceCents: 4500,
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
  expect(validateLiveConfig(config, config.customerIds).rankTargets).toEqual(
    config.rankTargets,
  );
  for (const rankTargets of [
    [{ ...config.rankTargets![0], customerId: 'cus_other' }],
    [config.rankTargets![0], config.rankTargets![0]],
    [{ ...config.rankTargets![0], targetRank: 11 }],
    [{ ...config.rankTargets![0], mode: 'test' }],
    [
      config.rankTargets![0],
      { ...config.rankTargets![0], customerId: 'cus_b' },
    ],
  ])
    expect(() =>
      validateLiveConfig({ ...config, rankTargets }, config.customerIds),
    ).toThrow();
  expect(() => validateRankTargets([{ mode: 'live' }])).toThrow();
});

it('never draws without fresh matching observations and only draws target accounts', () => {
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

it('reports cycle limit without claiming the rank was reached', () => {
  const state = running();
  refreshLiveRankGoals(state, [observation()], NOW);
  const cycle = claimLiveCycle(state, NOW)!;
  completeLiveCycle(
    state,
    { ...cycle, costCents: 4500, differenceCents: 0, bonusDifferenceCents: 0 },
    NOW + 1,
  );
  refreshLiveRankGoals(
    state,
    [{ ...observation(NOW + 3000), ownPulls: 2, ownValueMyr: 20 }],
    NOW + 3000,
  );
  claimLiveCycle(state, NOW + 3000);
  expect(state.rankGoals![0].status.state).toBe('limited');
  expect(state.status).toBe('completed');
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

it('does not let an owned-boundary wait block an eligible account', () => {
  const state = running();
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
  expect(state.rankGoals![0].status.state).toBe('conflict');
  expect(claimLiveCycle(state, NOW)?.customerId).toBe('cus_b');
});

it('respects real-clock Humanized sleep even when a rank draw is eligible', () => {
  const state = running();
  state.config = {
    ...config,
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
  state.config = { ...config, intervalSeconds: 60, maxCyclesPerAccount: 2 };
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
  state.config = { ...config, maxCyclesPerAccount: 2 };
  refreshLiveRankGoals(state, [observation()], NOW);
  state.nextDrawAt = NOW + 3000;
  expect(state.rankGoals![0].nextCheckAt).toBe(NOW + 15000);
  expect(liveRankTargetsToObserve(state, NOW + 2000)).toEqual([]);
  expect(liveRankTargetsToObserve(state, NOW + 3000)).toEqual(
    config.rankTargets,
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
