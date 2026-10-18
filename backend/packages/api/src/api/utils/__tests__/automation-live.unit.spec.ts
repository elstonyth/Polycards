import {
  claimLiveCycle,
  completeLiveCycle,
  createLiveState,
  executeLiveCycle,
  validateLiveConfig,
} from '../automation-live';
import { createHumanizedState, planHumanized } from '../automation-humanized';
import { DEFAULT_LIVE_TIMING } from '../automation-live-types';

const config = {
  packSlug: 'pokemon-white',
  customerIds: ['cus_live'],
  intervalSeconds: 5,
  maxCyclesPerAccount: 1,
};

describe('live automation', () => {
  it('uses random timing bounds and preserves fixed timing for legacy configurations', () => {
    for (const [timingMode, random, delay] of [
      ['fixed', 0.5, 5000],
      ['random', 0, 2000],
      ['random', 0.999999, 4000],
    ] as const) {
      const state = createLiveState();
      Object.assign(state, {
        status: 'running',
        config: {
          ...config,
          maxCyclesPerAccount: 2,
          timingMode,
          randomMinSeconds: 2,
          randomMaxSeconds: 4,
        },
      });
      const cycle = claimLiveCycle(state, 100)!;
      completeLiveCycle(
        state,
        { ...cycle, differenceCents: 0, bonusDifferenceCents: 0 },
        200,
        () => random,
      );
      expect(state.nextRunAt).toBe(200 + delay);
      expect(claimLiveCycle(state, 200 + delay - 1)).toBeNull();
    }
  });

  it('persists real-clock Humanized waits without drawing or fast-forwarding', () => {
    const state = createLiveState();
    const now = Date.parse('2026-10-18T00:00:00Z');
    Object.assign(state, {
      status: 'running',
      config: { ...config, timingMode: 'humanized', humanizedRegion: 'mysg' },
    });
    expect(claimLiveCycle(state, now, () => 0.5)).toBeNull();
    expect(state.status).toBe('running');
    expect(state.nextRunAt).toBe(now + 4 * 3600000);
    expect(state.schedules?.[0].waitReason).toContain('Sleeping');
    expect(
      claimLiveCycle(JSON.parse(JSON.stringify(state)), now + 1000, () => 0.01),
    ).toBeNull();
    expect(state.cycles).toEqual([]);
  });

  it('runs an eligible Humanized account without blocking it behind another account’s wait', () => {
    const humanized = createHumanizedState('cus_ready', 'mysg');
    let now = Date.parse('2026-10-18T04:00:00Z');
    for (let index = 0; index < 100; index++) {
      const plan = planHumanized(humanized, now, () => 0.5);
      if (plan.ready) break;
      now += plan.delayMs;
    }
    expect(planHumanized(humanized, now, () => 0.5).ready).toBe(true);
    const state = createLiveState();
    Object.assign(state, {
      status: 'running',
      config: {
        ...config,
        customerIds: ['cus_waiting', 'cus_ready'],
        maxCyclesPerAccount: 2,
        timingMode: 'humanized',
        humanizedRegion: 'mysg',
      },
      schedules: [
        {
          customerId: 'cus_waiting',
          humanized: createHumanizedState('cus_waiting', 'mysg'),
          nextRunAt: now + 86400000,
          waitReason: 'Between activity sessions',
        },
        {
          customerId: 'cus_ready',
          humanized,
          nextRunAt: now,
          waitReason: 'Within active session',
        },
      ],
    });
    const cycle = claimLiveCycle(state, now, () => 0.5)!;
    expect(cycle.customerId).toBe('cus_ready');
    expect(claimLiveCycle(state, now, () => 0.5)).toBeNull();
    completeLiveCycle(
      state,
      { ...cycle, differenceCents: 0, bonusDifferenceCents: 0 },
      now + 1000,
      () => 0.5,
    );
    expect(
      state.schedules?.find((row) => row.customerId === 'cus_ready')?.humanized
        .sessionDraws,
    ).toBe(1);
    expect(state.nextRunAt).toBeGreaterThan(now + 1000);
    expect(
      state.schedules?.find((row) => row.customerId === 'cus_waiting')
        ?.nextRunAt,
    ).toBe(now + 86400000);
  });

  it('validates production timing options and rejects accelerated clocks and reversed ranges', () => {
    for (const timingMode of ['fixed', 'random', 'humanized']) {
      expect(
        validateLiveConfig(
          {
            ...config,
            timingMode,
            randomMinSeconds: 2,
            randomMaxSeconds: 4,
            humanizedRegion: 'global',
          },
          ['cus_live'],
        ),
      ).toMatchObject({ timingMode, humanizedRegion: 'global' });
    }
    for (const invalid of [
      { timingMode: 'other' },
      { timingMode: ['humanized'] },
      { randomMinSeconds: 1 },
      { randomMinSeconds: 6, randomMaxSeconds: 4 },
      { randomMaxSeconds: 4.1 },
      { humanizedRegion: 'other' },
      { humanizedRegion: ['mysg'] },
      { humanizedTestClock: true },
    ])
      expect(() =>
        validateLiveConfig({ ...config, ...invalid }, ['cus_live']),
      ).toThrow();
  });
  it('finishes every selected cycle without a total spend cap, then completes immediately', () => {
    const state = createLiveState();
    Object.assign(state, {
      config: {
        ...config,
        maxSpendMyr: 10,
        maxCyclesPerAccount: 2,
        intervalSeconds: 86400,
      },
      packPriceCents: 900000,
      status: 'running',
      runId: 'run-1',
    });
    for (let index = 0; index < 2; index++) {
      state.nextRunAt = 0;
      const cycle = claimLiveCycle(state, 100)!;
      expect(cycle?.customerId).toBe('cus_live');
      completeLiveCycle(
        state,
        {
          ...cycle,
          costCents: 900000,
          differenceCents: 0,
          bonusDifferenceCents: 0,
        },
        200,
      );
      expect(state.status).toBe(index === 0 ? 'running' : 'completed');
    }
    expect(state.spentCents).toBe(1800000);
    expect(state.nextRunAt).toBeNull();
  });
  it('never starts from reading or saving settings, and never claims twice', () => {
    const state = createLiveState();
    state.config = config;
    state.packPriceCents = 1000;
    expect(claimLiveCycle(state, 100)).toBeNull();
    state.status = 'running';
    state.runId = 'run-1';
    expect(claimLiveCycle(state, 100)?.customerId).toBe('cus_live');
    expect(claimLiveCycle(state, 101)).toBeNull();
  });

  it('honors per-account cycles, next-run time and stop during settlement', () => {
    const state = createLiveState();
    Object.assign(state, {
      config,
      packPriceCents: 1000,
      status: 'running',
      runId: 'run-1',
    });
    const cycle = claimLiveCycle(state, 100)!;
    state.status = 'stopped';
    completeLiveCycle(
      state,
      {
        ...cycle,
        costCents: 1000,
        differenceCents: 0,
        bonusDifferenceCents: 0,
      },
      200,
    );
    expect(state.status).toBe('stopped');
    expect(state.spentCents).toBe(1000);
    expect(claimLiveCycle(state, 300)).toBeNull();
    state.status = 'running';
    expect(claimLiveCycle(state, 10000)).toBeNull();
    expect(state.status).toBe('completed');
  });

  it('fails closed on an interrupted cycle and retains its reference instead of retrying', () => {
    const state = createLiveState();
    Object.assign(state, {
      config,
      packPriceCents: 1000,
      status: 'running',
      runId: 'run-1',
    });
    const cycle = claimLiveCycle(state, 100)!;
    expect(claimLiveCycle(state, 400000)).toBeNull();
    expect(state.status).toBe('failed');
    expect(state.pending?.id).toBe(cycle.id);
    expect(state.error).toContain('review');
  });

  it('accepts only selected registered customers, never sandbox profiles', () => {
    expect(validateLiveConfig(config, ['cus_live'])).toEqual({
      ...DEFAULT_LIVE_TIMING,
      ...config,
    });
    for (const customerIds of [
      ['sandbox_001'],
      ['cus_other'],
      ['cus_live', 'cus_live'],
      [],
    ]) {
      expect(() =>
        validateLiveConfig({ ...config, customerIds }, ['cus_live']),
      ).toThrow();
    }
  });

  it('discards legacy spend caps while preserving the selected run settings', () => {
    expect(
      validateLiveConfig({ ...config, maxSpendMyr: 10 }, ['cus_live']),
    ).toEqual({ ...DEFAULT_LIVE_TIMING, ...config });
  });

  it('requires bounded intervals and cycle counts', () => {
    for (const input of [
      { maxCyclesPerAccount: 0 },
      { maxCyclesPerAccount: 11 },
      { intervalSeconds: 1 },
      { intervalSeconds: 5.5 },
      { packSlug: '' },
      {
        rankTargets: [
          { customerId: 'cus_live', period: 'invalid', targetRank: 1 },
        ],
      },
    ])
      expect(() =>
        validateLiveConfig({ ...config, ...input }, ['cus_live']),
      ).toThrow();
  });

  it('opens, records the real pull, sells that same pull, and verifies normal and bonus balances', async () => {
    const events: string[] = [];
    const result = await executeLiveCycle('cus_live', 'attempt-1', 10, {
      balance: async () =>
        events.length
          ? { balance: 23, bonusBalance: 0 }
          : { balance: 20, bonusBalance: 5 },
      open: async (customerId, openId, maxPrice) => {
        expect([customerId, openId, maxPrice]).toEqual([
          'cus_live',
          'attempt-1',
          10,
        ]);
        events.push('open');
        return {
          pullId: 'pull_real',
          cardName: 'Actual card',
          price: 10,
          bonusUsed: 5,
        };
      },
      checkpoint: async (result) => {
        expect(result.pullId).toBe('pull_real');
        events.push('checkpoint');
      },
      sell: async (customerId, pullId) => {
        expect([customerId, pullId]).toEqual(['cus_live', 'pull_real']);
        events.push('sell');
        return { amount: 13 };
      },
    });
    expect(events).toEqual(['open', 'checkpoint', 'sell']);
    expect(result).toMatchObject({
      pullId: 'pull_real',
      costCents: 1000,
      saleCents: 1300,
      expectedCents: 2300,
      endingCents: 2300,
      differenceCents: 0,
      bonusDifferenceCents: 0,
    });
  });

  it('never sells or repeats a draw after an open or durable-checkpoint failure', async () => {
    for (const stage of ['open', 'checkpoint']) {
      const open = jest.fn(async () => {
        if (stage === 'open') throw new Error('open failed');
        return {
          pullId: 'pull_real',
          cardName: 'Card',
          price: 10,
          bonusUsed: 0,
        };
      });
      const sell = jest.fn();
      await expect(
        executeLiveCycle('cus_live', 'attempt-1', 10, {
          balance: async () => ({ balance: 20, bonusBalance: 0 }),
          open,
          sell,
          checkpoint: async () => {
            throw new Error('checkpoint failed');
          },
        }),
      ).rejects.toThrow();
      expect(open).toHaveBeenCalledTimes(1);
      expect(sell).not.toHaveBeenCalled();
    }
  });

  it('reports a concurrent balance change as a mismatch', async () => {
    let reads = 0;
    const result = await executeLiveCycle('cus_live', 'attempt-1', 10, {
      balance: async () => ({
        balance: ++reads === 1 ? 20 : 24,
        bonusBalance: 0,
      }),
      open: async () => ({
        pullId: 'pull_real',
        cardName: 'Card',
        price: 10,
        bonusUsed: 0,
      }),
      checkpoint: async () => {},
      sell: async () => ({ amount: 13 }),
    });
    expect(result.differenceCents).toBe(100);
  });
});
