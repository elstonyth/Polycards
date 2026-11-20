import { describe, expect, it } from 'vitest';

import { createFlowInput, type FlowInput } from '../stage-flow-input';
import { focusStops } from '../stage-focus-keys';
import {
  createFocusLoad,
  createTouchGate,
  FOCUS_RETRY_MS,
  flowSwitch,
  panelState,
} from '../stage-flow-gate';

// panel 800: S = 1000; rests 1000..6000, RL 7000, edge 7500, exit 8000 to 9000
const GEO = { top: 0, panel: 800, viewport: 800 };
const SLEEVE = focusStops('sleeve');

/** A page focused on the centred pack, resting on Front (1000). */
function atFront() {
  let on = false;
  const input = createFlowInput({
    centreKinds: () => SLEEVE,
    focused: () => on,
    kinds: () => (on ? SLEEVE : []),
    enter: () => (on = true),
  });
  input.measure(GEO, 0);
  input.wheel(100, 0, false, 0, 0);
  const y = run(input, 0, 16, 1600);
  return { input, y };
}

function run(i: FlowInput, y0: number, from: number, to: number): number {
  let y = y0;
  for (let now = from; now <= to; now += 16) {
    const f = i.frame(y, now);
    if (f.scrollTo !== null) y = f.scrollTo;
  }
  return y;
}

describe('touch gate: a second finger (review finding 2)', () => {
  it('a pinch drops the touch: the page it left off a rest snaps back and the loop may sleep', () => {
    const p = atFront();
    expect(p.y).toBe(1000);
    const gate = createTouchGate(p.input, () => false);
    expect(gate.start(1, true, 200, 600, 1000, 1700)).toBe(true);
    // the second finger lands: the flow lets go of the touch
    expect(gate.start(2, true, 200, 600, 1000, 1716)).toBe(false);
    expect(gate.move(2, 200, 500, 1000, 1732)).toBe(false);
    // one finger lifts, then the other: no page
    expect(gate.end(1000, 1748)).toBe(false);
    expect(gate.end(1000, 1764)).toBe(false);
    // the pinch left the page at 1180
    const y = run(p.input, 1180, 1780, 2800);
    expect(y).toBe(1000);
    expect(p.input.frame(y, 2816).idle).toBe(true);
  });
});

describe('touch gate: a release while the focused view leaves', () => {
  it('drops the touch instead of keeping it: the snap and the idle report come back', () => {
    const p = atFront();
    let leaving = false;
    const gate = createTouchGate(p.input, () => leaving);
    gate.start(1, true, 200, 600, 1000, 1700);
    leaving = true;
    // held: every move is cancelled and the release pages nothing
    expect(gate.move(1, 200, 400, 1000, 1716)).toBe(true);
    expect(gate.end(1000, 1732)).toBe(false);
    leaving = false;
    const y = run(p.input, 1180, 1748, 2800);
    expect(y).toBe(1000);
    expect(p.input.frame(y, 2816).idle).toBe(true);
  });
});

describe('touch gate: one finger', () => {
  it('a swipe pages one stop', () => {
    const p = atFront();
    const gate = createTouchGate(p.input, () => false);
    expect(gate.start(1, true, 200, 600, 1000, 1700)).toBe(true);
    expect(gate.move(1, 200, 560, 1000, 1716)).toBe(true);
    expect(gate.move(1, 200, 500, 1000, 1732)).toBe(true);
    expect(gate.end(1000, 1748)).toBe(true);
    expect(run(p.input, 1000, 1764, 3400)).toBe(2000);
  });

  it("a touch that is not the flow's (a sheet, the tab bar) is never tracked", () => {
    const p = atFront();
    const gate = createTouchGate(p.input, () => false);
    expect(gate.start(1, false, 200, 600, 1000, 1700)).toBe(false);
    expect(gate.move(1, 200, 400, 1000, 1716)).toBe(false);
    expect(gate.end(1000, 1732)).toBe(false);
    expect(run(p.input, 1000, 1748, 3400)).toBe(1000);
  });
});

describe('flow switch: whether the flow runs', () => {
  const at = {
    reduced: false,
    empty: false,
    focusFailed: false,
    was: false,
    scrollY: 0,
    r0: 0,
    panel: 800,
  };

  it('switches on at the row, never for a page already down it, and stays on once on', () => {
    expect(flowSwitch(at)).toBe(true);
    expect(flowSwitch({ ...at, scrollY: 401 })).toBe(false);
    expect(flowSwitch({ ...at, scrollY: 5000, was: true })).toBe(true);
  });

  it('is off under reduced motion, for an empty stage, and while the focused view cannot be had', () => {
    expect(flowSwitch({ ...at, reduced: true })).toBe(false);
    expect(flowSwitch({ ...at, empty: true })).toBe(false);
    expect(flowSwitch({ ...at, focusFailed: true, was: true })).toBe(false);
  });
});

/** A load the test settles by hand. */
function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

describe("focus load: the focused view's chunk (review finding 1)", () => {
  function loader() {
    const loads: ReturnType<typeof deferred<string | null>>[] = [];
    const events: string[] = [];
    const l = createFocusLoad<string>({
      load: () => {
        const d = deferred<string | null>();
        loads.push(d);
        return d.promise;
      },
      ready: (v, down) => events.push(`ready ${v}${down ? ' +down' : ''}`),
      failed: () => events.push('failed'),
    });
    return { l, loads, events };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('one load at a time; its value is kept', async () => {
    const { l, loads, events } = loader();
    void l.get(0);
    void l.get(10);
    expect(loads).toHaveLength(1);
    loads[0]!.resolve('run');
    await tick();
    expect(events).toEqual(['ready run']);
    expect(l.value()).toBe('run');
    expect(await l.get(20)).toBe('run');
    expect(loads).toHaveLength(1);
  });

  it('a failed load is reported and retried by a later call, not cached', async () => {
    const { l, loads, events } = loader();
    void l.get(0);
    loads[0]!.reject(new Error('chunk'));
    await tick();
    expect(events).toEqual(['failed']);
    expect(l.failed()).toBe(true);
    // too soon after the failure: no new request
    expect(await l.get(FOCUS_RETRY_MS - 1)).toBeNull();
    expect(loads).toHaveLength(1);
    void l.get(FOCUS_RETRY_MS + 10);
    expect(loads).toHaveLength(2);
    loads[1]!.resolve('run');
    await tick();
    expect(events).toEqual(['failed', 'ready run']);
  });

  it('stays failed while a retry is in flight, until it succeeds', async () => {
    const { l, loads } = loader();
    void l.get(0);
    loads[0]!.reject(new Error('chunk'));
    await tick();
    void l.get(FOCUS_RETRY_MS + 10);
    expect(loads).toHaveLength(2);
    // a re-measure meanwhile must not switch the flow back on
    expect(l.failed()).toBe(true);
    loads[1]!.resolve('run');
    await tick();
    expect(l.failed()).toBe(false);
  });

  it('a down gesture held while loading is handed over once with the value', async () => {
    const { l, loads, events } = loader();
    void l.get(0);
    l.holdDown();
    loads[0]!.resolve('run');
    await tick();
    expect(events).toEqual(['ready run +down']);
  });

  it('a held down gesture is dropped when the load fails', async () => {
    const { l, loads, events } = loader();
    void l.get(0);
    l.holdDown();
    loads[0]!.reject(new Error('chunk'));
    await tick();
    void l.get(FOCUS_RETRY_MS + 10);
    loads[1]!.resolve('run');
    await tick();
    expect(events).toEqual(['failed', 'ready run']);
  });

  it('a load with nothing to show yet (null) is neither kept nor a failure', async () => {
    const { l, loads, events } = loader();
    void l.get(0);
    loads[0]!.resolve(null);
    await tick();
    expect(events).toEqual([]);
    expect(l.failed()).toBe(false);
    void l.get(1);
    expect(loads).toHaveLength(2);
  });
});

describe('panel state past Closing (review findings 4 and 5)', () => {
  it('at a stop the panel takes taps and the 3D is shown', () => {
    expect(panelState(0, 6000, 9000)).toEqual({
      inert: false,
      free: false,
      shown: true,
    });
    // a sub-pixel scroll off the rest is still the rest
    expect(panelState(0.0002, 6000.4, 9000)).toEqual({
      inert: false,
      free: false,
      shown: true,
    });
  });

  it('a fading pack takes no taps; a gone one is not drawn; the free part hides the panel', () => {
    expect(panelState(0.4, 6800, 9000)).toEqual({
      inert: true,
      free: false,
      shown: true,
    });
    expect(panelState(1, 8000, 9000)).toEqual({
      inert: true,
      free: false,
      shown: false,
    });
    expect(panelState(1, 9000, 9000)).toEqual({
      inert: true,
      free: true,
      shown: false,
    });
  });

  it('the free part hides it even with no fade span', () => {
    expect(panelState(0, 9000, 9000)).toEqual({
      inert: true,
      free: true,
      shown: false,
    });
  });
});
