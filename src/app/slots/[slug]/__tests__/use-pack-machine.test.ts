// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { flush, renderHook } from '@/lib/__tests__/render-hook';
import {
  usePackMachine,
  type PackMachineEffects,
  type PackMachineOptions,
} from '../usePackMachine';
import type { RollDeps, RolledBatch, RollRequest } from '@/lib/roll-batch';
import type { WonCard } from '@/lib/actions/packs';
import { FLOOD_MS, revealTimings, BLAST_MS } from '@/lib/reveal-phase';
import { spinTotalMs } from '@/lib/vault-reel';

// The reveal session as one module: the phase, the data that rides with it, and
// the timers that move it. Real timing runs here (reduced motion off) — the
// full-mount suites mock reduced motion on, so this is the only place the flood
// → transform → review beats are clocked. The server actions are injected
// RollDeps fakes; the real rollBatch seam and pressOutcome run.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const won = (handle: string, rarity: WonCard['rarity'] = 'Rare'): WonCard => ({
  handle,
  name: handle,
  image: `/x/${handle}.webp`,
  slabImage: null,
  priceMyr: 20,
  rarity,
  pokemonDex: null,
  spriteImage: null,
});

const roll = (card: WonCard) => ({
  card,
  pullId: `pull_${card.handle}`,
  marketValue: 1,
  buyback: null,
});

function makeDeps(cards: WonCard[] = [won('a')]) {
  return {
    openBatch: vi.fn<RollDeps['openBatch']>(async () => ({
      ok: true as const,
      rolls: cards.map(roll),
      price: 10,
      total: 10 * cards.length,
      balance: 490,
      giftsUsed: 0,
    })),
    openPack: vi.fn(),
    spinTaskReward: vi.fn(),
    now: () => 1_000,
    random: () => 0.5,
  } satisfies RollDeps;
}

function makeEffects() {
  return {
    applyBalance: vi.fn(),
    refetchBalance: vi.fn<() => Promise<unknown>>(async () => {}),
    refreshVaultDot: vi.fn(),
    resetGifts: vi.fn(),
    consumeGifts: vi.fn(),
    trackOpen: vi.fn(),
    openLogin: vi.fn(),
  } satisfies PackMachineEffects;
}

const request = (over: Partial<RollRequest> = {}): RollRequest => ({
  mode: 'paid',
  packId: 'bronze',
  reels: 1,
  gifts: 0,
  freeRipClaimId: null,
  demoPool: [],
  demoOdds: [{ rarity: 'Rare', chance: '100%' }],
  forId: 'cus_1',
  ...over,
});

let props: PackMachineOptions;
let effects: ReturnType<typeof makeEffects>;
let deps: ReturnType<typeof makeDeps>;
let onSettled: ReturnType<typeof vi.fn<(batch: RolledBatch) => void>>;

function setup(over: Partial<PackMachineOptions> = {}) {
  effects = makeEffects();
  deps = makeDeps();
  onSettled = vi.fn<(batch: RolledBatch) => void>();
  props = {
    customerId: 'cus_1',
    reduced: false,
    deps,
    effects,
    toWinner: (c) => ({ dex: null, rarity: c.rarity, rarityRgb: '0 0 0' }),
    onPress: vi.fn(),
    onSettled,
    ...over,
  };
  return renderHook(usePackMachine, props);
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('usePackMachine — a press through the reveal', () => {
  test('resolving → spinning → flood → transform → review → idle', async () => {
    const h = setup();
    let pressed!: Promise<void>;
    act(() => {
      pressed = h.current.press(request());
    });
    expect(h.current.state.phase).toBe('resolving');
    expect(h.current.hasSpun).toBe(true);
    await act(async () => pressed);
    expect(deps.openBatch).toHaveBeenCalledTimes(1);
    expect(h.current.state.phase).toBe('spinning');
    // The debit paints at charge time, before a reel turns.
    expect(effects.applyBalance).toHaveBeenCalledWith(490);
    expect(effects.trackOpen).toHaveBeenCalledWith(1);
    expect(effects.refreshVaultDot).toHaveBeenCalledTimes(1);

    act(() => h.current.settle());
    expect(h.current.state.phase).toBe('flood');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(h.current.announce).toBe('Won a, RM 20.00');

    const beats = revealTimings(1, false);
    await advance(FLOOD_MS);
    expect(h.current.state.phase).toBe('transform');
    await advance(beats.reviewMs - FLOOD_MS);
    const s = h.current.state;
    expect(s.phase).toBe('review');
    expect(
      s.phase !== 'idle' && s.phase !== 'resolving' && s.batch.offers,
    ).toHaveLength(1);

    act(() => h.current.conclude());
    expect(h.current.state).toEqual({ phase: 'idle' });
    // The screen-reader line outlives the reveal until the next press.
    expect(h.current.announce).toBe('Won a, RM 20.00');
    expect(h.current.hasSpun).toBe(true);
    h.unmount();
  });

  test('a second settle is a no-op', async () => {
    const h = setup();
    await act(async () => h.current.press(request()));
    act(() => h.current.settle());
    act(() => h.current.settle());
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(effects.applyBalance).toHaveBeenCalledTimes(2); // charge + settle
    h.unmount();
  });

  test('skip from the flood jumps to review; the stale beats change nothing', async () => {
    const h = setup();
    await act(async () => h.current.press(request()));
    act(() => h.current.settle());
    act(() => h.current.skip());
    expect(h.current.state.phase).toBe('review');
    await advance(10_000);
    expect(h.current.state.phase).toBe('review');
    h.unmount();
  });

  test('conclude before review holds the phase AND its batch', async () => {
    const h = setup();
    await act(async () => h.current.press(request()));
    act(() => h.current.settle());
    await advance(FLOOD_MS);
    expect(h.current.state.phase).toBe('transform');
    act(() => h.current.conclude());
    const s = h.current.state;
    expect(s.phase).toBe('transform');
    expect(s.phase === 'transform' && s.batch.cards).toHaveLength(1);
    h.unmount();
  });

  test('reduced motion cuts straight to review, with no blast', async () => {
    const h = setup({ reduced: true });
    deps.openBatch.mockResolvedValue({
      ok: true,
      rolls: [roll(won('x', 'Immortal'))],
      price: 10,
      total: 10,
      balance: 490,
      giftsUsed: 0,
    });
    await act(async () => h.current.press(request()));
    act(() => h.current.settle());
    await advance(0);
    expect(h.current.state.phase).toBe('review');
    expect(h.current.blast).toBe(false);
    expect(h.current.announce).toBe('Big win! Won x, RM 20.00');
    h.unmount();
  });

  test('a top-rarity win blasts the room, then stops', async () => {
    const h = setup();
    deps.openBatch.mockResolvedValue({
      ok: true,
      rolls: [roll(won('x', 'Immortal'))],
      price: 10,
      total: 10,
      balance: 490,
      giftsUsed: 0,
    });
    await act(async () => h.current.press(request()));
    act(() => h.current.settle());
    expect(h.current.blast).toBe(true);
    await advance(BLAST_MS);
    expect(h.current.blast).toBe(false);
    h.unmount();
  });

  test('the cooldown locks the button briefly after a settle', async () => {
    const h = setup();
    await act(async () => h.current.press(request()));
    act(() => h.current.settle());
    expect(h.current.cooldown).toBe(true);
    await advance(600);
    expect(h.current.cooldown).toBe(false);
    h.unmount();
  });

  test('the watchdog settles a reel that never reported', async () => {
    const h = setup();
    await act(async () => h.current.press(request()));
    expect(h.current.state.phase).toBe('spinning');
    await advance(spinTotalMs(1) + 2000);
    expect(h.current.state.phase).not.toBe('spinning');
    expect(onSettled).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  test('a cosmetic mapping throw still lands the paid result', async () => {
    const h = setup({
      toWinner: () => {
        throw new Error('bad sprite');
      },
    });
    await act(async () => h.current.press(request()));
    expect(h.current.state.phase).toBe('flood');
    expect(onSettled).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  test('unmount mid-flood leaves no beat behind', async () => {
    const h = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => h.current.press(request()));
    act(() => h.current.settle());
    h.unmount();
    await advance(10_000);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('usePackMachine — identity', () => {
  test('an account switch before settle drops the whole result', async () => {
    const h = setup();
    await act(async () => h.current.press(request()));
    expect(effects.applyBalance).toHaveBeenCalledTimes(1);
    h.rerender({ ...props, customerId: 'cus_2' });
    act(() => h.current.settle());
    expect(h.current.state).toEqual({ phase: 'idle' });
    expect(effects.applyBalance).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
    h.unmount();
  });

  test('an account switch during the round-trip paints nothing', async () => {
    const h = setup();
    let release!: () => void;
    deps.openBatch.mockImplementation(
      () =>
        new Promise((r) => {
          release = () =>
            r({
              ok: true,
              rolls: [roll(won('a'))],
              price: 10,
              total: 10,
              balance: 490,
              giftsUsed: 1,
            });
        }),
    );
    let pressed!: Promise<void>;
    act(() => {
      pressed = h.current.press(request({ gifts: 1 }));
    });
    h.rerender({ ...props, customerId: 'cus_2' });
    await act(async () => {
      release();
      await pressed;
    });
    expect(effects.applyBalance).not.toHaveBeenCalled();
    expect(effects.consumeGifts).not.toHaveBeenCalled();
    expect(effects.refreshVaultDot).not.toHaveBeenCalled();
    h.unmount();
  });

  test('a demo is bound to no account: a login mid-roll keeps it', async () => {
    const h = setup({ customerId: null });
    const pool = [won('d')];
    await act(async () =>
      h.current.press(request({ mode: 'demo', demoPool: pool, forId: null })),
    );
    expect(deps.openBatch).not.toHaveBeenCalled();
    expect(h.current.state.phase).toBe('spinning');
    h.rerender({ ...props, customerId: 'cus_9' });
    act(() => h.current.settle());
    const s = h.current.state;
    expect(s.phase).toBe('flood');
    expect(s.phase === 'flood' && s.batch.mode).toBe('demo');
    expect(h.current.announce).toBe('Demo — Won d, RM 20.00');
    h.unmount();
  });
});

describe('usePackMachine — a press that failed', () => {
  test('unreachable: the warning shows at once, the button waits for the balance', async () => {
    const h = setup();
    let refetched!: () => void;
    effects.refetchBalance.mockImplementation(
      () => new Promise<void>((r) => (refetched = r)),
    );
    deps.openBatch.mockRejectedValue(new Error('offline'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let pressed!: Promise<void>;
    act(() => {
      pressed = h.current.press(request({ gifts: 1 }));
    });
    await flush();
    expect(h.current.error).toMatch(/Couldn't reach the machine/);
    expect(h.current.state.phase).toBe('resolving');
    expect(effects.resetGifts).toHaveBeenCalledTimes(1);
    expect(h.current.hasSpun).toBe(false);
    await act(async () => {
      refetched();
      await pressed;
    });
    expect(h.current.state).toEqual({ phase: 'idle' });
    errors.mockRestore();
    h.unmount();
  });

  test('a refetch that rejects still unlocks the button', async () => {
    const h = setup();
    effects.refetchBalance.mockRejectedValue(new Error('down'));
    deps.openBatch.mockResolvedValue({ ok: false, error: 'In your vault' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => h.current.press(request()));
    expect(h.current.state).toEqual({ phase: 'idle' });
    expect(h.current.error).toBe('In your vault');
    expect(effects.refreshVaultDot).toHaveBeenCalledTimes(1);
    errors.mockRestore();
    h.unmount();
  });

  test('needs a top-up: the flag is up and nothing is re-read', async () => {
    const h = setup();
    deps.openBatch.mockResolvedValue({
      ok: false,
      error: 'Not enough',
      needsTopUp: true,
    });
    await act(async () => h.current.press(request()));
    expect(h.current.needsTopUp).toBe(true);
    expect(effects.refetchBalance).not.toHaveBeenCalled();
    h.unmount();
  });

  test('needs auth opens the login', async () => {
    const h = setup();
    deps.openBatch.mockResolvedValue({
      ok: false,
      error: 'Log in',
      needsAuth: true,
    });
    await act(async () => h.current.press(request()));
    expect(effects.openLogin).toHaveBeenCalledTimes(1);
    expect(h.current.error).toBeNull();
    h.unmount();
  });

  test('a blocked press moves nothing', async () => {
    const h = setup({ customerId: null });
    await act(async () =>
      h.current.press(request({ mode: 'demo', demoPool: [], forId: null })),
    );
    expect(h.current.state).toEqual({ phase: 'idle' });
    expect(h.current.hasSpun).toBe(false);
    expect(h.current.error).toMatch(/No cards in this pack/);
  });

  test('refuse shows a line without touching the machine', () => {
    const h = setup();
    act(() => h.current.refuse('Not enough balance to spin.', true));
    expect(h.current.error).toBe('Not enough balance to spin.');
    expect(h.current.needsTopUp).toBe(true);
    expect(h.current.state).toEqual({ phase: 'idle' });
    h.unmount();
  });

  test('a press while not idle is ignored', async () => {
    const h = setup();
    act(() => {
      void h.current.press(request());
    });
    await act(async () => h.current.press(request()));
    expect(deps.openBatch).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});
