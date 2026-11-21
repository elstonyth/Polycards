// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageSpinSource, StageState } from '../contract';

// The focused view's chunk: a stand-in whose stop() ends the focus the way
// the real one does (ended() re-measures the page).
const measuredInStop = { count: 0 };
let stopping = false;
vi.mock('../stage-focus-kit', () => ({
  createFocusRun: (d: { ended(): void }) => ({
    active: () => false,
    kindsAt: () => null,
    kinds: () => [],
    resume: () => false,
    debug: () => null,
    stop: () => d.ended(),
  }),
}));

type Key = string;
const live = new Map<Key, number>();
const keyOf = (
  t: EventTarget,
  type: string,
  o?: boolean | AddEventListenerOptions,
) => {
  const capture = typeof o === 'boolean' ? o : !!o?.capture;
  return `${targets.indexOf(t) < 0 ? targets.push(t) - 1 : targets.indexOf(t)}:${type}:${capture}`;
};
const targets: EventTarget[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  live.clear();
  // jsdom's window carries its own methods, apart from EventTarget's
  for (const host of [window, document, EventTarget.prototype]) {
    const add = host.addEventListener;
    const remove = host.removeEventListener;
    vi.spyOn(host, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type,
      fn,
      o,
    ) {
      const k = keyOf(this, type, o);
      live.set(k, (live.get(k) ?? 0) + 1);
      add.call(this, type, fn, o);
    });
    vi.spyOn(host, 'removeEventListener').mockImplementation(function (
      this: EventTarget,
      type,
      fn,
      o,
    ) {
      const k = keyOf(this, type, o);
      live.set(k, (live.get(k) ?? 0) - 1);
      remove.call(this, type, fn, o);
    });
  }
  vi.stubGlobal('matchMedia', () =>
    Object.assign(new EventTarget(), { matches: false }),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  window.scrollTo = () => {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const page = (): StageSpinSource => {
  const flow = document.createElement('div');
  const wrap = document.createElement('div');
  const panel = document.createElement('div');
  flow.append(wrap);
  wrap.append(panel);
  document.body.append(flow);
  const rect = panel.getBoundingClientRect.bind(panel);
  panel.getBoundingClientRect = () => {
    if (stopping) measuredInStop.count++;
    return rect();
  };
  return { flow, wrap, panel, empty: false };
};

describe('the spin kit lets go of everything it took', () => {
  it('bind, unbind, bind again, stop: every listener removed, no live region left, nothing measured on the way out', async () => {
    const { startSpin } = await import('../stage-spin-kit');
    const state = {
      intro: 1,
      track: 0,
      swap: 0,
      pointerX: 0,
      pointerY: 0,
      idle: 0,
      focus: 0,
      turn: 0,
      spin: 0,
      exit: 0,
    } as StageState;
    const kit = startSpin({
      stage: {
        state,
        wake: () => {},
        values: { spin: { set: () => {} }, exit: { set: () => {} } },
      },
      ui: () => {},
    });
    const src = page();
    kit.bind(src);
    kit.bind(null);
    kit.bind(src);
    // the focused view's chunk arrives at idle
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
    // window, document, media query and panel listeners are being counted
    expect([...live.values()].filter((n) => n > 0).length).toBeGreaterThan(10);
    stopping = true;
    kit.stop();
    stopping = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(measuredInStop.count).toBe(0);
    expect([...live].filter(([, n]) => n !== 0)).toEqual([]);
    expect(document.querySelector('[aria-live]')).toBeNull();
  });
});
