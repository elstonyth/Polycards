import { describe, expect, it } from 'vitest';

import { createFlowInput, type FlowInput } from '../stage-flow-input';
import { focusStops } from '../stage-focus-keys';
import {
  createFocusLoad,
  HOLD_MAX_MS,
  LOAD_DEADLINE_MS,
  holdStands,
  createTouchGate,
  FOCUS_RETRY_MS,
  flowSwitch,
  panelState,
} from '../stage-flow-gate';

// panel 800: S = 1000; rests 1000..6000, RL 7000, edge 7500, exit 7000 to 9000
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

describe('touch gate: the touch events carry their own time', () => {
  it("passes each event's own time to the flow beside the handling time", () => {
    const seen: string[] = [];
    const gate = createTouchGate(
      {
        touchStart: (_x, _y, _s, now, at) =>
          void seen.push(`start ${now} ${at}`),
        touchMove: (_x, _y, _s, now, at) => {
          seen.push(`move ${now} ${at}`);
          return true;
        },
        touchEnd: (_s, now, at) => void seen.push(`end ${now} ${at}`),
        touchCancel: () => void seen.push('cancel'),
      },
      () => false,
    );
    gate.start(1, true, 200, 600, 9000, 100, { at: 90 });
    gate.move(1, 200, 560, 9000, 120, 106);
    gate.end(9000, 300, 112);
    expect(seen).toEqual(['start 100 90', 'move 120 106', 'end 300 112']);
  });

  it('a touch whose start time is not on the frame clock (an old epoch time) is timed by its handling throughout', () => {
    const seen: string[] = [];
    const gate = createTouchGate(
      {
        touchStart: (_x, _y, _s, _now, at) => void seen.push(`start ${at}`),
        touchMove: (_x, _y, _s, _now, at) => {
          seen.push(`move ${at}`);
          return true;
        },
        touchEnd: (_s, _now, at) => void seen.push(`end ${at}`),
        touchCancel: () => void seen.push('cancel'),
      },
      () => false,
    );
    const epoch = 1.7e12;
    gate.start(1, true, 200, 600, 9000, 100, { at: epoch });
    gate.move(1, 200, 560, 9000, 120, 106);
    gate.end(9000, 300, epoch + 200);
    expect(seen).toEqual(['start 100', 'move 120', 'end 300']);
  });
});

describe('touch gate: which event times fit the frame clock', () => {
  /** The times the flow is handed for a touch whose start was made at `startAt`. */
  function times(startAt: number | undefined, moveAt: number) {
    const seen: string[] = [];
    const gate = createTouchGate(
      {
        touchStart: (_x, _y, _s, _now, at) => void seen.push(`start ${at}`),
        touchMove: (_x, _y, _s, _now, at) => {
          seen.push(`move ${at}`);
          return true;
        },
        touchEnd: (_s, _now, at) => void seen.push(`end ${at}`),
        touchCancel: () => void seen.push('cancel'),
      },
      () => false,
    );
    gate.start(1, true, 200, 600, 9000, 100, { at: startAt });
    gate.move(1, 200, 560, 9000, 120, moveAt);
    return seen;
  }

  it('an event time up to 1 ms ahead of its handling (a 1 ms rounding) fits, and is capped at the handling time', () => {
    expect(times(101, 106)).toEqual(['start 100', 'move 106']);
    expect(times(90, 120.5)).toEqual(['start 90', 'move 120']);
  });

  it('a start time more than 1 ms ahead, zero or below, or missing: the whole touch is timed by its handling', () => {
    expect(times(101.01, 106)).toEqual(['start 100', 'move 120']);
    expect(times(0, 106)).toEqual(['start 100', 'move 120']);
    expect(times(-5, 106)).toEqual(['start 100', 'move 120']);
    expect(times(undefined, 106)).toEqual(['start 100', 'move 120']);
  });
});

describe('touch gate: the handling clock (event times that do not fit)', () => {
  it('moves queued behind a long task and handled in a burst give a bounded glide, timed from the move before the burst', () => {
    const p = atFront();
    const gate = createTouchGate(p.input, () => false);
    let y = 9500;
    // no event times: the gate times the touch by when it was handled
    gate.start(1, true, 200, 700, y, 0);
    gate.move(1, 200, 668, y, 16);
    y = p.input.follow() ?? y;
    // a 150 ms long task: five 32 px moves handled at 166.1 to 166.5
    for (let i = 1; i <= 5; i++) {
      gate.move(1, 200, 668 - 32 * i, y, 166 + i * 0.1);
      y = p.input.follow() ?? y;
    }
    expect(y).toBe(9692);
    gate.end(y, 166.6);
    // 160 px over the 150.5 ms from the move before the burst: 17.7 px per
    // 60 Hz frame, about 133 px of glide (the burst alone would ask 2.2 million)
    const glide = run(p.input, y, 176, 6000) - y;
    expect(glide).toBeGreaterThan(125);
    expect(glide).toBeLessThan(140);
  });
});

describe('touch gate: a second finger', () => {
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

describe('touch gate: a touch the system cancels', () => {
  it('is never a release: a swipe past the threshold, then a touchcancel, pages nothing', () => {
    const p = atFront();
    const gate = createTouchGate(p.input, () => false);
    expect(gate.start(1, true, 200, 600, 1000, 1700)).toBe(true);
    expect(gate.move(1, 200, 560, 1000, 1716)).toBe(true);
    expect(gate.move(1, 200, 500, 1000, 1732)).toBe(true);
    gate.cancel();
    // the touch is gone: a later end is not ours
    expect(gate.end(1000, 1748)).toBe(false);
    const y = run(p.input, 1000, 1764, 3400);
    expect(y).toBe(1000);
    expect(p.input.frame(y, 3416).idle).toBe(true);
  });

  it('a cancel with no touch tracked does nothing', () => {
    const p = atFront();
    const gate = createTouchGate(p.input, () => false);
    gate.cancel();
    expect(run(p.input, 1000, 1700, 3400)).toBe(1000);
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

describe("focus load: the focused view's chunk", () => {
  function loader() {
    const loads: ReturnType<typeof deferred<string | null>>[] = [];
    const events: string[] = [];
    const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
    const l = createFocusLoad<string>({
      load: () => {
        const d = deferred<string | null>();
        loads.push(d);
        return d.promise;
      },
      ready: (v, held) =>
        events.push(`ready ${v}${held ? ` +down ${held.where}` : ''}`),
      failed: () => events.push('failed'),
      after: (ms, fn) => {
        const t = { ms, fn, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
    });
    /** The deadline of the latest load passes (if it is still armed). */
    const deadline = () => {
      const t = timers.at(-1);
      if (t && !t.cancelled) t.fn();
    };
    return { l, loads, events, timers, deadline };
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
    l.holdDown(100, 'tab:2');
    loads[0]!.resolve('run');
    await tick();
    expect(events).toEqual(['ready run +down tab:2']);
  });

  it('a held down gesture is dropped when the load fails', async () => {
    const { l, loads, events } = loader();
    void l.get(0);
    l.holdDown(100, 'tab:2');
    loads[0]!.reject(new Error('chunk'));
    await tick();
    void l.get(FOCUS_RETRY_MS + 10);
    loads[1]!.resolve('run');
    await tick();
    expect(events).toEqual(['failed', 'ready run']);
  });

  it('a load that stalls past its deadline counts as failed; when it lands later the value is taken', async () => {
    const { l, loads, events, timers, deadline } = loader();
    void l.get(0);
    expect(timers[0]!.ms).toBe(LOAD_DEADLINE_MS);
    expect(LOAD_DEADLINE_MS).toBe(2500);
    expect(l.failed()).toBe(false);
    deadline();
    expect(l.failed()).toBe(true);
    expect(events).toEqual(['failed']);
    // the same request goes on: no second one meanwhile
    void l.get(LOAD_DEADLINE_MS + 50);
    expect(loads).toHaveLength(1);
    loads[0]!.resolve('run');
    await tick();
    expect(l.failed()).toBe(false);
    expect(events).toEqual(['failed', 'ready run']);
  });

  it('a down gesture held through the deadline is dropped', async () => {
    const { l, loads, events, deadline } = loader();
    void l.get(0);
    l.holdDown(100, 'tab:2');
    deadline();
    loads[0]!.resolve('run');
    await tick();
    expect(events).toEqual(['failed', 'ready run']);
  });

  it('the deadline is disarmed when the load settles, and by stop()', async () => {
    const { l, loads, events, timers, deadline } = loader();
    void l.get(0);
    loads[0]!.resolve('run');
    await tick();
    expect(timers[0]!.cancelled).toBe(true);
    deadline();
    expect(events).toEqual(['ready run']);
    const b = loader();
    void b.l.get(0);
    b.l.stop();
    expect(b.timers[0]!.cancelled).toBe(true);
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

describe('a held down gesture', () => {
  it('stands only at the same place, and never later than 3 s after it was made', () => {
    expect(HOLD_MAX_MS).toBe(3000);
    const hold = { at: 1000, where: 'tab:poly|151' };
    expect(holdStands(hold, 1000, 'tab:poly|151')).toBe(true);
    expect(holdStands(hold, 4000, 'tab:poly|151')).toBe(true);
    expect(holdStands(hold, 4001, 'tab:poly|151')).toBe(false);
    expect(holdStands(hold, 1500, 'tab:poly|cr')).toBe(false);
    expect(holdStands(hold, 1500, 'tab:sets|151')).toBe(false);
    expect(holdStands(null, 1500, 'tab:poly|151')).toBe(false);
  });
});

describe('panel state past Closing', () => {
  it('at a stop the panel takes taps and the 3D is shown', () => {
    expect(panelState(0, 6000, 9000)).toEqual({
      inert: false,
      free: false,
      lap: false,
    });
    // a sub-pixel scroll off the rest is still the rest
    expect(panelState(0.0002, 6000.4, 9000)).toEqual({
      inert: false,
      free: false,
      lap: false,
    });
  });

  it('from the first frame of the hand-off the panel takes no taps, the 3D stays drawn through the lineup and its exit, and the free part hides it', () => {
    expect(panelState(0.4, 6800, 9000)).toEqual({
      inert: true,
      free: false,
      lap: false,
    });
    // the lineup at rest, and its exit
    expect(panelState(1, 7000, 9000)).toEqual({
      inert: true,
      free: false,
      lap: false,
    });
    expect(panelState(1, 8900, 9000)).toEqual({
      inert: true,
      free: false,
      lap: false,
    });
    expect(panelState(1, 9000, 9000)).toEqual({
      inert: true,
      free: true,
      lap: false,
    });
  });

  it('the panel shows again from the rise on (the lap), still taking no taps; the 3D is never sent away', () => {
    // free span: 9000 to the rise start at 10720
    expect(panelState(1, 10000, 9000, 10720)).toEqual({
      inert: true,
      free: true,
      lap: false,
    });
    expect(panelState(1, 10720, 9000, 10720)).toEqual({
      inert: true,
      free: false,
      lap: true,
    });
    expect(panelState(0, 13500, 9000, 10720)).toEqual({
      inert: true,
      free: false,
      lap: true,
    });
  });

  it('the free part hides it even with no hand-off (a pack that cannot be focused)', () => {
    expect(panelState(0, 9000, 9000)).toEqual({
      inert: true,
      free: true,
      lap: false,
    });
  });
});
