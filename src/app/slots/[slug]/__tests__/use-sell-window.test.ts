// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { createElement, act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SELL_TIMEOUT_MESSAGE,
  useSellWindow,
  type SellBackOffer,
} from '../useSellWindow';

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
    bonus: 0,
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

    expect(onSold).toHaveBeenCalledWith(170, 70, 0);
    expect(onSellFailed).not.toHaveBeenCalled();
  });
});

describe('useSellWindow — a sell nobody answers never hangs the stage', () => {
  type SellResult = Awaited<
    ReturnType<Parameters<typeof useSellWindow>[0]['onSellBack']>
  >;

  test('times out to an error, then still credits a sale that lands late', async () => {
    let answer!: (r: SellResult) => void;
    const onSold = vi.fn();
    const hook = renderHook(() =>
      useSellWindow({
        offers: [offerAt(Date.now() + 30_000)],
        active: true,
        onSellBack: vi.fn(() => new Promise<SellResult>((r) => (answer = r))),
        onSold,
        sellTimeoutMs: 30,
      }),
    );
    mounted = hook;

    let result: boolean | undefined;
    await act(async () => {
      result = await hook.current.sell(0);
    });
    // Not stuck on 'selling': the expiry sweep can now vault it and conclude.
    expect(result).toBe(false);
    expect(hook.current.states[0]).toEqual({
      phase: 'error',
      message: SELL_TIMEOUT_MESSAGE,
    });

    await act(async () => {
      answer({ ok: true, amount: 70, percent: 70, balance: 170 });
    });
    expect(hook.current.states[0]).toEqual({ phase: 'sold', amount: 70 });
    expect(onSold).toHaveBeenCalledWith(170, 70, 0);
  });

  test("a retry's refusal never paints a late sale back to an error", async () => {
    const answers: ((r: SellResult) => void)[] = [];
    const hook = renderHook(() =>
      useSellWindow({
        offers: [offerAt(Date.now() + 30_000)],
        active: true,
        onSellBack: vi.fn(
          () => new Promise<SellResult>((r) => answers.push(r)),
        ),
        sellTimeoutMs: 30,
      }),
    );
    mounted = hook;

    await act(async () => {
      await hook.current.sell(0); // first request hangs, times out
    });
    let retry!: Promise<boolean>;
    act(() => {
      retry = hook.current.sell(0); // player taps Sell again
    });
    await act(async () => {
      answers[0]!({ ok: true, amount: 70, percent: 70, balance: 170 });
      answers[1]!({ ok: false, error: 'Already sold.' });
      await retry;
    });
    expect(hook.current.states[0]).toEqual({ phase: 'sold', amount: 70 });
  });
});

describe('useSellWindow — no error toast over a sale that landed', () => {
  type SellResult = Awaited<
    ReturnType<Parameters<typeof useSellWindow>[0]['onSellBack']>
  >;

  test("a retry's refusal after the deadline does not toast over the late sale", async () => {
    const answers: ((r: SellResult) => void)[] = [];
    const onSellFailed = vi.fn();
    const onSold = vi.fn();
    const deadline = Date.now() + 80;
    const hook = renderHook(() =>
      useSellWindow({
        offers: [offerAt(deadline)],
        active: true,
        onSellBack: vi.fn(
          () => new Promise<SellResult>((r) => answers.push(r)),
        ),
        onSold,
        onSellFailed,
        sellTimeoutMs: 30,
      }),
    );
    mounted = hook;

    await act(async () => {
      await hook.current.sell(0); // hangs, times out inside the window
    });
    let retry!: Promise<boolean>;
    act(() => {
      retry = hook.current.sell(0);
    });
    await act(async () => {
      answers[0]!({ ok: true, amount: 70, percent: 70, balance: 170 });
      await new Promise((r) => setTimeout(r, 100)); // cross the deadline
      answers[1]!({ ok: false, error: 'This card was already sold back.' });
      await retry;
    });
    expect(onSold).toHaveBeenCalledTimes(1);
    expect(onSellFailed).not.toHaveBeenCalled();
  });
});

describe('useSellWindow — a late answer never lands on the next batch', () => {
  type SellResult = Awaited<
    ReturnType<Parameters<typeof useSellWindow>[0]['onSellBack']>
  >;

  test('credits the balance but leaves the new batch card untouched', async () => {
    let answer!: (r: SellResult) => void;
    const onSold = vi.fn();
    const onSellBack = vi.fn(
      () => new Promise<SellResult>((r) => (answer = r)),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const box: { current?: ReturnType<typeof useSellWindow> } = {};
    function Probe({ offer }: { offer: SellBackOffer }) {
      const result = useSellWindow({
        offers: [offer],
        active: true,
        onSellBack,
        onSold,
        sellTimeoutMs: 30,
      });
      useLayoutEffect(() => {
        box.current = result;
      });
      return null;
    }
    let root!: Root;
    const first = offerAt(Date.now() + 30_000);
    const second = { ...offerAt(Date.now() + 30_000), pullId: 'pull_2' };
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { offer: first }));
    });
    mounted = {
      unmount: () => {
        act(() => root.unmount());
        container.remove();
      },
    };

    await act(async () => {
      await box.current!.sell(0); // times out
    });
    act(() => root.render(createElement(Probe, { offer: second }))); // next spin
    expect(box.current!.states[0]).toEqual({ phase: 'idle' });

    await act(async () => {
      answer({ ok: true, amount: 70, percent: 70, balance: 170 });
    });
    expect(box.current!.states[0]).toEqual({ phase: 'idle' });
    expect(onSold).toHaveBeenCalledWith(170, 70, 0);
  });
});

describe('useSellWindow — the for-packs part of a sale', () => {
  async function sellOnce(offer: SellBackOffer, soldAmount: number) {
    const onSold = vi.fn();
    const hook = renderHook(() =>
      useSellWindow({
        offers: [offer],
        active: true,
        onSellBack: vi.fn(async () => ({
          ok: true as const,
          amount: soldAmount,
          percent: 50,
          balance: 200,
        })),
        onSold,
      }),
    );
    mounted = hook;
    await act(async () => {
      await hook.current.sell(0);
    });
    return onSold;
  }

  test('scales the quoted free part to a late vault-rate sale', async () => {
    // Quoted RM 70 instant with RM 35 from bonus; the server paid the vault
    // rate (RM 50), so half of THAT is for packs.
    const offer = { ...offerAt(Date.now() + 30_000), bonus: 35 };
    expect(await sellOnce(offer, 50)).toHaveBeenCalledWith(200, 50, 25);
  });

  test('an unpriced quote reports nothing held instead of NaN', async () => {
    const offer = { ...offerAt(Date.now() + 30_000), amount: 0, bonus: 5 };
    expect(await sellOnce(offer, 50)).toHaveBeenCalledWith(200, 50, 0);
  });
});
