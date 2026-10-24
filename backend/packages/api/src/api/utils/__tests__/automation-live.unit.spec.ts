import {
  beginLiveRound,
  canRepeatLiveRound,
  claimLiveCycle,
  completeLiveCycle,
  createLiveState,
  executeLiveCycle,
  pickLivePack,
  summarizeLiveRun,
  validateLiveConfig,
} from '../automation-live';
import { createHumanizedState, planHumanized } from '../automation-humanized';
import { DEFAULT_LIVE_TIMING } from '../automation-live-types';
import type { LiveConfig } from '../automation-live-types';

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
    expect(state.nextRunAt).toBe(now + 13_500_000);
    expect(state.schedules?.[0].waitReason).toContain('Sleeping');
    expect(
      claimLiveCycle(JSON.parse(JSON.stringify(state)), now + 1000, () => 0.01),
    ).toBeNull();
    expect(state.cycles).toEqual([]);
  });

  it('runs the whole Humanized day faster at higher speed, sleep included', () => {
    const now = Date.parse('2026-10-18T00:00:00Z');
    const run = (humanizedPace: number) => {
      const state = createLiveState();
      Object.assign(state, {
        status: 'running',
        startedAt: now,
        config: {
          ...config,
          timingMode: 'humanized',
          humanizedRegion: 'mysg',
          humanizedPace,
        },
      });
      claimLiveCycle(state, now, () => 0.5);
      return state;
    };
    // Same player, same night: at 5× the 3.75 h sleep passes in 45 min.
    expect(run(1).nextRunAt).toBe(now + 13_500_000);
    const fast = run(5);
    expect(fast.nextRunAt).toBe(now + 2_700_000);
    expect(fast.schedules?.[0].waitReason).toContain('Sleeping');
    // After waking (45 real min later) the player clock is past its alarm.
    expect(
      claimLiveCycle(fast, now + 2_700_000, () => 0.5)?.customerId ??
        fast.schedules?.[0].waitReason,
    ).not.toContain('Sleeping');
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
  it('ends only the skipped account and keeps the run going for the rest', () => {
    const state = createLiveState();
    Object.assign(state, {
      config: {
        ...config,
        customerIds: ['cus_broke', 'cus_live'],
        maxCyclesPerAccount: 2,
        intervalSeconds: 2,
      },
      status: 'running',
      runId: 'run-1',
    });
    const broke = claimLiveCycle(state, 100)!;
    expect(broke.customerId).toBe('cus_broke');
    completeLiveCycle(state, { ...broke, skipped: 'Balance too low' }, 200);
    expect(state.status).toBe('running');
    expect(state.error).toBeNull();
    for (const now of [3000, 6000]) {
      const cycle = claimLiveCycle(state, now)!;
      expect(cycle.customerId).toBe('cus_live');
      completeLiveCycle(
        state,
        { ...cycle, differenceCents: 0, bonusDifferenceCents: 0 },
        now + 100,
      );
    }
    expect(state.status).toBe('completed');
    expect(
      state.cycles.filter((cycle) => cycle.customerId === 'cus_broke'),
    ).toHaveLength(1);
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

  it('picks packs by basis-point weight and skips packs the balance cannot cover', () => {
    const mix = [
      { packSlug: 'bronze', weightBp: 7500 },
      { packSlug: 'diamond', weightBp: 2500 },
    ];
    const prices = { bronze: 5000, diamond: 500000 };
    expect(pickLivePack(mix, prices, 1_000_000, () => 0)).toBe('bronze');
    expect(pickLivePack(mix, prices, 1_000_000, () => 0.7499)).toBe('bronze');
    expect(pickLivePack(mix, prices, 1_000_000, () => 0.75)).toBe('diamond');
    expect(pickLivePack(mix, prices, 1_000_000, () => 0.999999)).toBe(
      'diamond',
    );
    // RM 100 covers Bronze only: Diamond drops out for this draw.
    expect(pickLivePack(mix, prices, 10000, () => 0.999999)).toBe('bronze');
    // Nothing affordable: the full mix stands and the open fails as usual.
    expect(pickLivePack(mix, prices, 0, () => 0.999999)).toBe('diamond');
  });

  it('accepts a pack mix in 0.01% steps that totals exactly 100%', () => {
    const packMix = [
      ['celebration', 2500],
      ['ascended', 2000],
      ['bronze', 2500],
      ['silver', 1500],
      ['gold', 1000],
      ['platinum', 250],
      ['diamond', 200],
      ['poncho', 50],
      ['unused', 0],
    ].map(([packSlug, weightBp]) => ({ packSlug, weightBp }));
    expect(
      validateLiveConfig({ ...config, packSlug: '', packMix }, ['cus_live'])
        .packMix,
    ).toEqual(packMix.slice(0, 8));
    for (const bad of [
      [{ packSlug: 'bronze', weightBp: 9999 }],
      [
        { packSlug: 'bronze', weightBp: 9999.5 },
        { packSlug: 'gold', weightBp: 0.5 },
      ],
      [
        { packSlug: 'bronze', weightBp: 5000 },
        { packSlug: 'bronze', weightBp: 5000 },
      ],
      [{ packSlug: 'bronze', weightBp: 10000, extra: 1 }],
      [{ packSlug: 'bad slug', weightBp: 10000 }],
      [],
    ])
      expect(() =>
        validateLiveConfig({ ...config, packMix: bad }, ['cus_live']),
      ).toThrow();
  });

  it('bounds Humanized speed to whole 1–24× steps', () => {
    expect(
      validateLiveConfig({ ...config, humanizedPace: 5 }, ['cus_live'])
        .humanizedPace,
    ).toBe(5);
    for (const humanizedPace of [0, 25, 1.5, '2'])
      expect(() =>
        validateLiveConfig({ ...config, humanizedPace }, ['cus_live']),
      ).toThrow();
  });

  it('serves the longest-waiting due Humanized account first', () => {
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
    const late = ready('cus_late');
    const early = ready('cus_early');
    const now = Math.max(late.now, early.now) + 60_000;
    late.humanized.nextDrawAt = now - 1000;
    early.humanized.nextDrawAt = now - 50_000;
    const state = createLiveState();
    Object.assign(state, {
      status: 'running',
      config: {
        ...config,
        customerIds: ['cus_late', 'cus_early'],
        timingMode: 'humanized',
        humanizedRegion: 'mysg',
      },
      schedules: [
        {
          customerId: 'cus_late',
          humanized: late.humanized,
          nextRunAt: now - 1000,
          waitReason: 'Within active session',
        },
        {
          customerId: 'cus_early',
          humanized: early.humanized,
          nextRunAt: now - 50_000,
          waitReason: 'Within active session',
        },
      ],
    });
    expect(claimLiveCycle(state, now, () => 0.5)?.customerId).toBe('cus_early');
  });

  it('summarizes a run for the history list', () => {
    const state = createLiveState();
    expect(summarizeLiveRun(state)).toBeNull();
    Object.assign(state, {
      status: 'stopped',
      runId: 'run-1',
      startedAt: 50,
      spentCents: 2000,
      config: {
        ...config,
        packSlug: '',
        packMix: [
          { packSlug: 'bronze', weightBp: 6000 },
          { packSlug: 'gold', weightBp: 4000 },
        ],
      },
      cycles: [
        {
          id: 'a',
          customerId: 'cus_a',
          startedAt: 100,
          finishedAt: 200,
          error: null,
          saleCents: 900,
          differenceCents: 0,
          bonusDifferenceCents: 0,
        },
        {
          id: 'b',
          customerId: 'cus_b',
          startedAt: 300,
          finishedAt: 400,
          error: 'Insufficient balance',
        },
      ],
    });
    expect(summarizeLiveRun(state)).toEqual({
      runId: 'run-1',
      startedAt: 50,
      endedAt: 400,
      status: 'stopped',
      draws: 2,
      settled: 1,
      failed: 1,
      spentCents: 2000,
      soldCents: 900,
      accounts: 2,
      packSlugs: ['bronze', 'gold'],
      timingMode: 'fixed',
    });
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

describe('repeating live rounds', () => {
  const settled = { differenceCents: 0, bonusDifferenceCents: 0 };
  const repeatRun = () =>
    Object.assign(createLiveState(), {
      config: { ...config, timingMode: 'fixed', repeat: true } as LiveConfig,
      packPriceCents: 1000,
      packPricesCents: { 'pokemon-white': 1000 },
      status: 'running' as const,
      runId: 'round-1',
      startedAt: 50,
    });

  it('keeps a repeat run going after its last draw, then finishes the round for the next one', () => {
    const state = repeatRun();
    const cycle = claimLiveCycle(state, 100)!;
    completeLiveCycle(state, { ...cycle, ...settled, costCents: 1000 }, 200);
    expect(state.status).toBe('running');
    expect(claimLiveCycle(state, state.nextRunAt!)).toBeNull();
    expect(state.status).toBe('completed');
    expect(canRepeatLiveRound(state)).toBe(true);
  });

  it('does not repeat a round that failed, was stopped, drew nothing or stopped a goal for safety', () => {
    const done = () => {
      const state = repeatRun();
      const cycle = claimLiveCycle(state, 100)!;
      completeLiveCycle(state, { ...cycle, ...settled }, 200);
      claimLiveCycle(state, state.nextRunAt!);
      return state;
    };
    expect(canRepeatLiveRound({ ...done(), config: { ...config } })).toBe(
      false,
    );
    expect(canRepeatLiveRound({ ...done(), status: 'failed' })).toBe(false);
    expect(canRepeatLiveRound({ ...done(), status: 'stopped' })).toBe(false);
    const broke = repeatRun();
    const skip = claimLiveCycle(broke, 100)!;
    completeLiveCycle(broke, { ...skip, skipped: 'Balance too low' }, 200);
    claimLiveCycle(broke, broke.nextRunAt!);
    expect(broke.status).toBe('completed');
    expect(canRepeatLiveRound(broke)).toBe(false);
    const unsafe = done();
    unsafe.rankGoals = [
      {
        done: true,
        status: { state: 'pending_timeout' },
      } as unknown as NonNullable<typeof unsafe.rankGoals>[number],
    ];
    expect(canRepeatLiveRound(unsafe)).toBe(false);
  });

  it('starts the next round fresh but keeps Humanized schedules and their clock', () => {
    const state = repeatRun();
    state.config = {
      ...state.config,
      timingMode: 'humanized',
      humanizedRegion: 'mysg',
    };
    const schedule = {
      customerId: 'cus_live',
      humanized: createHumanizedState('cus_live', 'mysg'),
      nextRunAt: 9000,
      waitReason: 'Between activity sessions',
    };
    Object.assign(state, {
      status: 'completed',
      schedules: [schedule],
      cycles: [
        {
          id: 'c1',
          customerId: 'cus_live',
          startedAt: 100,
          finishedAt: 200,
          error: null,
          costCents: 1000,
          saleCents: 700,
          ...settled,
        },
      ],
      spentCents: 1000,
      rankGoals: [],
    });
    beginLiveRound(
      state,
      {
        config: state.config,
        packPriceCents: 1200,
        packPricesCents: { 'pokemon-white': 1200 },
      },
      5000,
      true,
    );
    expect(state).toMatchObject({
      status: 'running',
      cycles: [],
      spentCents: 0,
      startedAt: 5000,
      clockStartedAt: 50,
      nextRunAt: 5000,
      packPricesCents: { 'pokemon-white': 1200 },
      error: null,
    });
    expect(state.runId).not.toBe('round-1');
    expect(state.rankGoals).toBeUndefined();
    expect(state.schedules).toEqual([schedule]);
    expect(state.history?.[0]).toMatchObject({
      runId: 'round-1',
      draws: 1,
      settled: 1,
      soldCents: 700,
    });
  });
});
