/**
 * @vitest-environment jsdom
 */
// What the stage provider releases: every listener and observer it adds, its
// canvas and its runtime, across a breakpoint rebuild and a stop. The engine's
// own forced context loss on dispose must not count as a crash.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ disposed: 0, created: 0 }));

vi.mock('../stage-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stage-gate')>()),
  gateStage: () => 'full',
}));

vi.mock('../runtime/stage-runtime', () => ({
  createStageRuntime: ({ canvas }: { canvas: HTMLCanvasElement }) => {
    engine.created++;
    return new Proxy(
      {},
      {
        get: (_t, key) =>
          key === 'prepare'
            ? () => Promise.resolve()
            : key === 'dispose'
              ? () => {
                  engine.disposed++;
                  // what renderer.forceContextLoss() fires
                  canvas.dispatchEvent(new Event('webglcontextlost'));
                }
              : () => undefined,
      },
    );
  },
}));

import { readCrashFlag } from '../crash-guard';
import { StageEngine } from '../Stage3dProvider';

/** Net listeners per (target, type, handler) still attached. */
let live: Map<string, number>;
let observing: number;
/** The desktop query's change handler. */
let mqlChange: (() => void) | null;
let desktop = false;

beforeEach(() => {
  live = new Map();
  observing = 0;
  mqlChange = null;
  engine.disposed = engine.created = 0;
  sessionStorage.clear();
  const ids = new WeakMap<object, number>();
  let next = 0;
  const id = (o: object) => {
    if (!ids.has(o)) ids.set(o, next++);
    return ids.get(o);
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(
    function (this: EventTarget, type, fn, o) {
      if (fn) {
        const k = `${id(this)} ${type} ${id(fn)}`;
        live.set(k, (live.get(k) ?? 0) + 1);
      }
      add.call(this, type, fn, o);
    },
  );
  vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(
    function (this: EventTarget, type, fn, o) {
      if (fn) {
        const k = `${id(this)} ${type} ${id(fn)}`;
        if (live.has(k)) live.set(k, Math.max(0, live.get(k)! - 1));
      }
      remove.call(this, type, fn, o);
    },
  );
  class Observer {
    observe() {
      observing++;
    }
    disconnect() {
      observing--;
    }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  vi.stubGlobal('IntersectionObserver', Observer);
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return q.includes('min-width') ? desktop : q.includes('pointer: fine');
    },
    addEventListener: (_: string, fn: () => void) => {
      if (q.includes('min-width')) mqlChange = fn;
    },
    removeEventListener: (_: string, fn: () => void) => {
      if (mqlChange === fn) mqlChange = null;
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const attached = () => [...live.values()].reduce((s, n) => s + n, 0);

describe('stage teardown', () => {
  it('releases every listener, observer, canvas and runtime it made', async () => {
    const before = attached();
    const stage = document.createElement('section');
    const host = document.createElement('div');
    stage.append(host);
    document.body.append(stage);

    const e = new StageEngine();
    e.setHost(host);
    e.start({ override: null, debug: false });
    await vi.waitFor(() => expect(engine.created).toBe(1));
    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    expect(observing).toBe(2);

    // a breakpoint crossing rebuilds the runtime on a new canvas
    desktop = true;
    mqlChange?.();
    expect(engine.created).toBe(2);
    expect(engine.disposed).toBe(1);
    expect(host.querySelectorAll('canvas')).toHaveLength(1);

    e.stop();
    expect(engine.disposed).toBe(2);
    expect(host.querySelectorAll('canvas')).toHaveLength(0);
    expect(observing).toBe(0);
    expect(mqlChange).toBeNull();
    expect(attached()).toBe(before);
    // the forced context loss on each dispose was not taken for a crash
    expect(readCrashFlag()).toBe(false);
    expect(e.getSnapshot().mode).not.toBe('flat');
  });
});
