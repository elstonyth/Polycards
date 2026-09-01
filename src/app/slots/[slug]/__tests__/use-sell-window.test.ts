// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { createElement, act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSellWindow, type SellBackOffer } from '../useSellWindow';

// #514: a sell that FAILS has to reach a surface that outlives this stage, the
// way a successful one already does through `onSold`. Once the 30s clock is out
// the errored card is swept to 'vaulted' with everything else, so the reveal's
// own red line never renders and the stage auto-concludes seconds later — the
// notification is the whole fix, and it lives in this hook.
//
// Same createRoot + act harness as src/lib/__tests__/use-pack-detail-poll.test.ts
// (no @testing-library in this repo; react-dom + jsdom are already installed).
// The result is captured in a layout effect so it stays a side effect rather
// than a render impurity — act() flushes those synchronously.
// Silences React's "testing environment is not configured to support act(...)"
// warning — the same opt-in every other createRoot test in this repo makes.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook<T>(useHook: () => T) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const box: { current: T } = { current: undefined as unknown as T };
  let root!: Root;
  function Probe() {
    const result = useHook();
    useLayoutEffect(() => {
      box.current = result;
    });
    return null;
  }
  act(() => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });
  return {
    get current() {
      return box.current;
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// Every field the hook itself reads; the rest is presentation for RevealStage.
function offerAt(deadlineMs: number): SellBackOffer {
  return {
    pullId: 'pull_1',
    fmv: 100,
    cardName: 'Test Card',
    image: '',
    slabImage: null,
    percent: 70,
    amount: 70,
    vaultPercent: 50,
    vaultAmount: 50,
    instantDeadlineMs: deadlineMs,
    firm: true,
  };
}

// The hook ticks the wall clock on a 250ms interval while `active` — unmount
// every render or the interval outlives the test file.
let mounted: { unmount: () => void } | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('useSellWindow — a failed sell is never silent (#514)', () => {
  test('a server refusal is reported out of the stage, not just into the card', async () => {
    const onSellFailed = vi.fn();
    const onSold = vi.fn();
    const onSellBack = vi.fn(async () => ({
      ok: false as const,
      error: 'Exchange rate unavailable.',
    }));
    const hook = renderHook(() =>
      useSellWindow({
        offers: [offerAt(Date.now() + 30_000)],
        active: true,
        onSellBack,
        onSold,
        onSellFailed,
      }),
    );
    mounted = hook;

    await act(async () => {
      await hook.current.sell(0);
    });

    expect(onSellBack).toHaveBeenCalledTimes(1);
    // Inside the window the card's own red line is the whole report — it will
    // still be on screen. No toast: duplicating it is noise on the MAJORITY
    // failure path, and this is the path the sweep never touches.
    expect(hook.current.states[0]).toEqual({
      phase: 'error',
      message: 'Exchange rate unavailable.',
    });
    expect(onSellFailed).not.toHaveBeenCalled();
    expect(onSold).not.toHaveBeenCalled();
  });

  test('a refusal that lands AFTER the deadline leaves the stage', async () => {
    // The #514 case itself: the request was in flight when the clock ran out,
    // so the sweep is about to map this card to 'vaulted' and the inline error
    // never renders. This is the failure that needs a surface outliving the
    // stage -- and it is decided by the raw clock, because `expired` captured
    // in the closure is stale exactly here.
    const onSellFailed = vi.fn();
    const deadline = Date.now() + 40;
    const onSellBack = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { ok: false as const, error: 'Exchange rate unavailable.' };
    });
    const hook = renderHook(() =>
      useSellWindow({
        offers: [offerAt(deadline)],
        active: true,
        onSellBack,
        onSellFailed,
      }),
    );
    mounted = hook;

    await act(async () => {
      await hook.current.sell(0);
    });

    expect(onSellBack).toHaveBeenCalledTimes(1);
    expect(onSellFailed).toHaveBeenCalledWith('Exchange rate unavailable.');
  });

  test('a thrown request is reported too, with the copy the card shows', async () => {
    const onSellFailed = vi.fn();
    const hook = renderHook(() =>
      useSellWindow({
        offers: [offerAt(Date.now() + 30_000)],
        active: true,
        onSellBack: vi.fn(() => Promise.reject(new Error('offline'))),
        onSellFailed,
      }),
    );
    mounted = hook;

    await act(async () => {
      await hook.current.sell(0);
    });

    // In-window throw: the card reports it, the stage does not need to.
    expect(hook.current.states[0]).toEqual({
      phase: 'error',
      message: 'Something went wrong. Please try again.',
    });
    expect(onSellFailed).not.toHaveBeenCalled();
  });

  test('a Confirm past the deadline fires nothing and says so', async () => {
    // The SellConfirmModal's Confirm is gated only on `busy`, so a tap landing
    // at/after the flip used to pass the guard (which read the RAW states) and
    // fire a request the server refuses. Now the guard resolves first — and the
    // block itself gets a message, or the player presses Sell into silence,
    // which is the same bug by another route.
    const onSellFailed = vi.fn();
    const onSellBack = vi.fn(async () => ({
      ok: true as const,
      amount: 70,
      percent: 70,
      balance: 170,
    }));
    const hook = renderHook(() =>
      useSellWindow({
        offers: [offerAt(Date.now() - 1)], // window already closed
        active: true,
        onSellBack,
        onSellFailed,
      }),
    );
    mounted = hook;

    expect(hook.current.expired).toBe(true);

    let result: boolean | undefined;
    await act(async () => {
      result = await hook.current.sell(0);
    });

    expect(result).toBe(false);
    expect(onSellBack).not.toHaveBeenCalled();
    expect(onSellFailed).toHaveBeenCalledWith(
      'The instant offer closed — the card is safe in your vault.',
    );
  });

  test('a successful sell still reports only through onSold', async () => {
    const onSellFailed = vi.fn();
    const onSold = vi.fn();
    const hook = renderHook(() =>
      useSellWindow({
        offers: [offerAt(Date.now() + 30_000)],
        active: true,
        onSellBack: vi.fn(async () => ({
          ok: true as const,
          amount: 70,
          percent: 70,
          balance: 170,
        })),
        onSold,
        onSellFailed,
      }),
    );
    mounted = hook;

    await act(async () => {
      await hook.current.sell(0);
    });

    expect(onSold).toHaveBeenCalledWith(170, 70);
    expect(onSellFailed).not.toHaveBeenCalled();
  });
});
