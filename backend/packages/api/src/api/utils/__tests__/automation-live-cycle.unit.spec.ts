import {
  completeLiveCycle,
  createLiveState,
  executeLiveCycle,
  liveAccountRefusal,
  liveCycleServices,
  planLiveDraw,
} from '../automation-live';
import type { LiveCycleDeps } from '../automation-live';
import type { LiveConfig, LiveCycle } from '../automation-live-types';

const config: LiveConfig = {
  packSlug: 'pokemon-white',
  customerIds: ['cus_live', 'cus_other'],
  intervalSeconds: 5,
  maxCyclesPerAccount: 2,
};

describe('liveAccountRefusal', () => {
  const reads = (selected: boolean, disabled: boolean, frozen: boolean) => ({
    selected: jest.fn(async () => selected),
    disabled: jest.fn(async () => disabled),
    frozen: jest.fn(async () => frozen),
  });

  // [selected, disabled, frozen, refusal, reads made]
  it.each([
    [true, false, false, null, 3],
    [false, false, false, 'Account is no longer selected or is disabled.', 1],
    [true, true, false, 'Account is no longer selected or is disabled.', 2],
    [false, true, false, 'Account is no longer selected or is disabled.', 1],
    [true, false, true, 'Account is frozen.', 3],
    [false, false, true, 'Account is no longer selected or is disabled.', 1],
    [true, true, true, 'Account is no longer selected or is disabled.', 2],
    [false, true, true, 'Account is no longer selected or is disabled.', 1],
  ] as const)(
    'selected=%s disabled=%s frozen=%s refuses with %p after %i reads',
    async (selected, disabled, frozen, refusal, made) => {
      const account = reads(selected, disabled, frozen);
      await expect(liveAccountRefusal(account)).resolves.toBe(refusal);
      // Reads run once each, in order (selected, disabled, frozen), and stop
      // at the first refusal.
      expect(
        [account.selected, account.disabled, account.frozen].map(
          (read) => read.mock.calls.length,
        ),
      ).toEqual([0, 1, 2].map((index) => (index < made ? 1 : 0)));
    },
  );

  it('lets a failed read through without making the later ones', async () => {
    const account = {
      ...reads(true, false, true),
      disabled: jest.fn(async () => {
        throw new Error('db down');
      }),
    };
    await expect(liveAccountRefusal(account)).rejects.toThrow('db down');
    expect(account.frozen).not.toHaveBeenCalled();
  });
});

describe('planLiveDraw', () => {
  const prices = { 'pokemon-white': 1000 };

  it('draws the single pack when the balance covers it, to the sen', () => {
    expect(planLiveDraw(config, prices, 1000)).toEqual({
      packSlug: 'pokemon-white',
      priceCents: 1000,
    });
  });

  it('skips with the exact wallet text when the balance is one sen short', () => {
    expect(planLiveDraw(config, prices, 999)).toEqual({
      packSlug: 'pokemon-white',
      priceCents: 1000,
      skipped:
        'Balance RM 9.99 cannot cover RM 10.00. No more draws for this account in this run.',
    });
  });

  it('skips an empty wallet', () => {
    expect(planLiveDraw(config, prices, 0).skipped).toBe(
      'Balance RM 0.00 cannot cover RM 10.00. No more draws for this account in this run.',
    );
  });

  it('keeps a pack with no price drawable, as before (the open is capped by max_price)', () => {
    // undefined compares false with <, so the draw proceeds; pinned, not changed.
    expect(planLiveDraw(config, {}, 0)).toEqual({
      packSlug: 'pokemon-white',
      priceCents: undefined,
    });
  });

  it('picks from a mix before the balance check, among packs the wallet covers', () => {
    const mix: LiveConfig = {
      ...config,
      packMix: [
        { packSlug: 'cheap', weightBp: 5000 },
        { packSlug: 'dear', weightBp: 5000 },
      ],
    };
    const mixPrices = { cheap: 500, dear: 5000 };
    // 0.99 would land on 'dear' over the whole mix; only 'cheap' is affordable.
    expect(planLiveDraw(mix, mixPrices, 600, () => 0.99)).toEqual({
      packSlug: 'cheap',
      priceCents: 500,
    });
    expect(planLiveDraw(mix, mixPrices, 6000, () => 0.99)).toEqual({
      packSlug: 'dear',
      priceCents: 5000,
    });
  });

  it('records the picked mix pack on a skip when nothing is affordable', () => {
    const mix: LiveConfig = {
      ...config,
      packMix: [
        { packSlug: 'cheap', weightBp: 5000 },
        { packSlug: 'dear', weightBp: 5000 },
      ],
    };
    expect(
      planLiveDraw(mix, { cheap: 500, dear: 5000 }, 100, () => 0.99),
    ).toEqual({
      packSlug: 'dear',
      priceCents: 5000,
      skipped:
        'Balance RM 1.00 cannot cover RM 50.00. No more draws for this account in this run.',
    });
  });

  it('ignores the mix weights for a single-pack config', () => {
    const random = jest.fn(() => 0.5);
    expect(planLiveDraw(config, prices, 5000, random).packSlug).toBe(
      'pokemon-white',
    );
    expect(random).not.toHaveBeenCalled();
  });
});

describe('a guard outcome and the run', () => {
  const claimed = () => {
    const state = createLiveState();
    state.status = 'running';
    state.config = config;
    state.runId = 'run_1';
    const cycle: LiveCycle = {
      id: 'cycle_1',
      customerId: 'cus_live',
      startedAt: 1,
      finishedAt: null,
      error: null,
    };
    state.pending = { ...cycle };
    return { state, cycle };
  };

  it('a refusal is a cycle error, which fails the whole run for review', async () => {
    const { state, cycle } = claimed();
    cycle.error = await liveAccountRefusal({
      selected: async () => true,
      disabled: async () => false,
      frozen: async () => true,
    });
    completeLiveCycle(state, cycle, 2, () => 0);
    expect(state.status).toBe('failed');
    expect(state.error).toBe('Account is frozen.');
  });

  it('a low-balance skip ends only that account, the run keeps going', () => {
    const { state, cycle } = claimed();
    const plan = planLiveDraw(config, { 'pokemon-white': 1000 }, 10);
    cycle.packSlug = plan.packSlug;
    cycle.skipped = plan.skipped;
    completeLiveCycle(state, cycle, 2, () => 0);
    expect(state.status).toBe('running');
    expect(state.error).toBeNull();
    expect(state.cycles[0]).toMatchObject({
      packSlug: 'pokemon-white',
      skipped: plan.skipped,
    });
  });
});

describe('liveCycleServices', () => {
  const opened = {
    pull: { id: 'pull_1' },
    card: { name: 'Pikachu', handle: 'pikachu-ex' },
    price: 10,
    bonus_cents: 250,
  };
  function setup(overrides: Partial<LiveCycleDeps> = {}) {
    const cycle: LiveCycle = {
      id: 'cycle_1',
      customerId: 'cus_live',
      startedAt: 1,
      finishedAt: null,
      error: null,
    };
    const pending: unknown[] = [];
    const deps: LiveCycleDeps = {
      cycle,
      packSlug: 'picked-pack',
      creditSummary: jest.fn(async () => ({ balance: 50, bonusBalance: 5 })),
      isAccountDisabled: jest.fn(async () => false),
      openPack: jest.fn(async () => opened),
      revealPull: jest.fn(async () => ({ first_reveal: true })),
      emit: jest.fn(async () => undefined),
      buyback: jest.fn(async () => ({ amount: 12 })),
      warn: jest.fn(),
      persist: jest.fn(async () => {
        pending.push({ ...cycle });
      }),
      ...overrides,
    };
    return { cycle, deps, pending, services: liveCycleServices(deps) };
  }

  it('reads the claimed account balance', async () => {
    const { deps, services } = setup();
    await expect(services.balance()).resolves.toEqual({
      balance: 50,
      bonusBalance: 5,
    });
    expect(deps.creditSummary).toHaveBeenCalledWith('cus_live');
  });

  it('opens the picked pack, reveals the new pull and announces a first reveal', async () => {
    const { deps, services } = setup();
    await expect(services.open('cus_live', 'cycle_1', 10)).resolves.toEqual({
      pullId: 'pull_1',
      cardName: 'Pikachu',
      price: 10,
      bonusUsed: 2.5,
    });
    expect(deps.openPack).toHaveBeenCalledWith({
      customer_id: 'cus_live',
      pack_id: 'picked-pack',
      open_id: 'cycle_1',
      max_price: 10,
    });
    expect(deps.revealPull).toHaveBeenCalledWith('pull_1', 'cus_live');
    expect(deps.emit).toHaveBeenCalledWith({
      name: 'pull.revealed',
      data: {
        pull_id: 'pull_1',
        pack_id: 'picked-pack',
        card_id: 'pikachu-ex',
        customer_id: 'cus_live',
      },
    });
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('does not announce a pull that was already revealed', async () => {
    const { deps, services } = setup({
      revealPull: jest.fn(async () => ({ first_reveal: false })),
    });
    await services.open('cus_live', 'cycle_1', 10);
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it.each([
    [
      'reveal',
      {
        revealPull: jest.fn(async () => {
          throw new Error('reveal down');
        }),
      },
      'reveal down',
    ],
    [
      'emit',
      {
        emit: jest.fn(async () => {
          throw new Error('bus down');
        }),
      },
      'bus down',
    ],
    [
      'non-Error reveal',
      {
        revealPull: jest.fn(async () => {
          throw 'nope';
        }),
      },
      'reveal unavailable',
    ],
  ])(
    'a failed %s never interrupts the paid draw',
    async (_label, overrides, reason) => {
      const { deps, services } = setup(overrides);
      await expect(
        services.open('cus_live', 'cycle_1', 10),
      ).resolves.toMatchObject({ pullId: 'pull_1' });
      expect(deps.warn).toHaveBeenCalledWith(
        `Live automation announcement dropped for pull pull_1: ${reason}`,
      );
    },
  );

  it('lets an open failure through (nothing was charged to settle)', async () => {
    const { services } = setup({
      openPack: jest.fn(async () => {
        throw { message: 'Insufficient credit' };
      }),
    });
    await expect(services.open('cus_live', 'cycle_1', 10)).rejects.toEqual({
      message: 'Insufficient credit',
    });
  });

  it('checkpoints the amounts onto the claimed cycle and persists it', async () => {
    const { cycle, deps, pending, services } = setup();
    await services.checkpoint({
      pullId: 'pull_1',
      cardName: 'Pikachu',
      costCents: 1000,
      startingCents: 5000,
      startingBonusCents: 500,
    });
    expect(cycle).toMatchObject({ pullId: 'pull_1', costCents: 1000 });
    expect(pending).toEqual([
      expect.objectContaining({ id: 'cycle_1', pullId: 'pull_1' }),
    ]);
    expect(deps.persist).toHaveBeenCalledTimes(1);
  });

  it('sells the card back through buyback', async () => {
    const { deps, services } = setup();
    await expect(services.sell('cus_live', 'pull_1')).resolves.toEqual({
      amount: 12,
    });
    expect(deps.buyback).toHaveBeenCalledWith({
      customer_id: 'cus_live',
      pull_id: 'pull_1',
    });
  });

  it('refuses to sell for an account disabled mid-cycle, leaving the card in the vault', async () => {
    const { deps, services } = setup({
      isAccountDisabled: jest.fn(async () => true),
    });
    await expect(services.sell('cus_live', 'pull_1')).rejects.toThrow(
      'Account was disabled before settlement. The paid card remains in the vault.',
    );
    expect(deps.buyback).not.toHaveBeenCalled();
  });

  it('runs a full cycle through executeLiveCycle with the pending row persisted before the sale', async () => {
    let balance = 50;
    const { cycle, deps, pending, services } = setup({
      creditSummary: jest.fn(async () => ({ balance, bonusBalance: 5 })),
      openPack: jest.fn(async () => {
        balance -= 10;
        return { ...opened, bonus_cents: 0 };
      }),
      buyback: jest.fn(async () => {
        expect(pending).toHaveLength(1);
        balance += 12;
        return { amount: 12 };
      }),
    });
    const amounts = await executeLiveCycle(
      cycle.customerId,
      cycle.id,
      10,
      services,
    );
    expect(amounts).toMatchObject({
      costCents: 1000,
      saleCents: 1200,
      startingCents: 5000,
      endingCents: 5200,
      differenceCents: 0,
      bonusDifferenceCents: 0,
    });
    expect(deps.persist).toHaveBeenCalledTimes(1);
  });
});
