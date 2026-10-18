import {
  claimLiveCycle,
  completeLiveCycle,
  createLiveState,
  executeLiveCycle,
  validateLiveConfig,
} from '../automation-live';

const config = {
  packSlug: 'pokemon-white',
  customerIds: ['cus_live'],
  intervalSeconds: 5,
  maxCyclesPerAccount: 1,
  maxSpendMyr: 100,
};

describe('live automation', () => {
  it('completes immediately when cycles or budget are exhausted, even with a one-day interval', () => {
    for (const limits of [
      { maxCyclesPerAccount: 1, maxSpendMyr: 100 },
      { maxCyclesPerAccount: 2, maxSpendMyr: 10 },
    ]) {
      const state = createLiveState();
      Object.assign(state, {
        config: { ...config, ...limits, intervalSeconds: 86400 },
        packPriceCents: 1000,
        status: 'running',
        runId: 'run-1',
      });
      const cycle = claimLiveCycle(state, 100)!;
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
      expect(state.status).toBe('completed');
      expect(state.nextRunAt).toBeNull();
    }
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

  it('honors spend, per-account cycles, next-run time and stop during settlement', () => {
    const state = createLiveState();
    Object.assign(state, {
      config: { ...config, maxSpendMyr: 10 },
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
    expect(validateLiveConfig(config, ['cus_live'])).toEqual(config);
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

  it('requires finite, cent-exact budgets and bounded intervals and cycle counts', () => {
    for (const input of [
      { maxSpendMyr: NaN },
      { maxSpendMyr: 0 },
      { maxSpendMyr: 8001 },
      { maxSpendMyr: 10.001 },
      { maxCyclesPerAccount: 0 },
      { maxCyclesPerAccount: 11 },
      { intervalSeconds: 1 },
      { intervalSeconds: 5.5 },
      { packSlug: '' },
      { rankTargets: [] },
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
