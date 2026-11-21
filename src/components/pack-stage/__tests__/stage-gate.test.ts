import { describe, expect, it } from 'vitest';

import { STAGE_CRASH_KEY } from '../crash-guard';
import {
  COARSE_POINTER_QUERY,
  REDUCED_DATA_QUERY,
  REDUCED_MOTION_QUERY,
  createFrameWatchdog,
  decideStageMode,
  gateStage,
  percentile,
  probeWebGL2,
  readCheapSignals,
  stagePrepaintExpression,
  stepDown,
  stepDownAllowed,
  type GateEnv,
  type StageSignals,
} from '../stage-gate';

type Fake = {
  queries?: string[];
  saveData?: boolean;
  deviceMemory?: number;
  webgl2?: 'ok' | 'caveat' | 'none' | 'throws';
};

function env(f: Fake = {}) {
  const contexts: { opts: Record<string, unknown>; lost: boolean }[] = [];
  let canvases = 0;
  const e: GateEnv = {
    navigator: {
      connection:
        f.saveData === undefined ? undefined : { saveData: f.saveData },
      deviceMemory: f.deviceMemory,
    },
    matchMedia: (q) => ({ matches: (f.queries ?? []).includes(q) }),
    createCanvas: () => {
      canvases++;
      return {
        getContext: (id: string, o?: object) => {
          if (f.webgl2 === 'throws') throw new Error('boom');
          if (id !== 'webgl2' || f.webgl2 === 'none') return null;
          const opts = (o ?? {}) as Record<string, unknown>;
          if (
            f.webgl2 === 'caveat' &&
            opts.failIfMajorPerformanceCaveat === true
          )
            return null;
          const rec = { opts, lost: false };
          contexts.push(rec);
          return {
            getExtension: (name: string) =>
              name === 'WEBGL_lose_context'
                ? { loseContext: () => void (rec.lost = true) }
                : null,
          };
        },
      };
    },
  };
  return { e, contexts, canvases: () => canvases };
}

const CLEAN: StageSignals = {
  reducedMotion: false,
  saveData: false,
  reducedData: false,
  deviceMemory: 8,
  coarsePointer: false,
  crashFlag: false,
  webgl2: true,
};

describe('decideStageMode', () => {
  it('passes a capable desktop at full 3d', () => {
    expect(decideStageMode(CLEAN)).toBe('3d');
    expect(decideStageMode({ ...CLEAN, deviceMemory: null })).toBe('3d');
  });

  it.each([
    ['reduced motion', { reducedMotion: true }],
    ['save-data', { saveData: true }],
    ['prefers-reduced-data', { reducedData: true }],
    ['crash flag', { crashFlag: true }],
    ['deviceMemory 2', { deviceMemory: 2 }],
    ['deviceMemory 1', { deviceMemory: 1 }],
    ['no WebGL2 / software GPU', { webgl2: false }],
    ['not probed', { webgl2: null }],
  ] as const)('is flat for %s', (_, over) => {
    expect(decideStageMode({ ...CLEAN, ...over })).toBe('flat');
  });

  it('starts low-memory devices at lite; phones (coarse pointer) start full', () => {
    expect(decideStageMode({ ...CLEAN, deviceMemory: 4 })).toBe('lite');
    expect(decideStageMode({ ...CLEAN, deviceMemory: 3 })).toBe('lite');
    expect(decideStageMode({ ...CLEAN, coarsePointer: true })).toBe('3d');
    expect(
      decideStageMode({ ...CLEAN, coarsePointer: true, deviceMemory: 4 }),
    ).toBe('lite');
    expect(
      decideStageMode({ ...CLEAN, coarsePointer: true, deviceMemory: null }),
    ).toBe('3d');
  });

  it('honours the override, but forced 3D still needs a context', () => {
    expect(decideStageMode(CLEAN, 'flat')).toBe('flat');
    // Forced 3D skips the device tiers...
    expect(decideStageMode({ ...CLEAN, deviceMemory: 1 }, '3d')).toBe('3d');
    expect(decideStageMode({ ...CLEAN, deviceMemory: 4 }, '3d')).toBe('3d');
    expect(decideStageMode({ ...CLEAN, webgl2: null }, '3d')).toBe('3d');
    // ...but never the visitor's choices or the crash flag.
    for (const over of [
      { reducedMotion: true },
      { saveData: true },
      { reducedData: true },
      { crashFlag: true },
    ])
      for (const o of ['3d', 'lite'] as const)
        expect(decideStageMode({ ...CLEAN, ...over }, o)).toBe('flat');
    expect(decideStageMode({ ...CLEAN, coarsePointer: true }, '3d')).toBe('3d');
    expect(decideStageMode(CLEAN, 'lite')).toBe('lite');
    expect(decideStageMode({ ...CLEAN, webgl2: false }, '3d')).toBe('flat');
  });
});

describe('readCheapSignals', () => {
  it('reads every signal from navigator and matchMedia', () => {
    const { e } = env({
      queries: [REDUCED_MOTION_QUERY, REDUCED_DATA_QUERY, COARSE_POINTER_QUERY],
      saveData: true,
      deviceMemory: 4,
    });
    expect(readCheapSignals(e, true)).toEqual({
      reducedMotion: true,
      saveData: true,
      reducedData: true,
      deviceMemory: 4,
      coarsePointer: true,
      crashFlag: true,
    });
  });

  it('treats missing APIs as unknown / false', () => {
    expect(readCheapSignals({}, false)).toEqual({
      reducedMotion: false,
      saveData: false,
      reducedData: false,
      deviceMemory: null,
      coarsePointer: false,
      crashFlag: false,
    });
    const throwingMm: GateEnv = {
      matchMedia: () => {
        throw new Error('nope');
      },
    };
    expect(readCheapSignals(throwingMm, false).reducedMotion).toBe(false);
  });
});

describe('probeWebGL2', () => {
  it('asks for failIfMajorPerformanceCaveat and releases the context', () => {
    const f = env({ webgl2: 'ok' });
    expect(probeWebGL2(f.e)).toBe(true);
    expect(f.contexts).toHaveLength(1);
    expect(f.contexts[0]?.opts.failIfMajorPerformanceCaveat).toBe(true);
    expect(f.contexts[0]?.lost).toBe(true);
  });

  it('fails a software GPU with the caveat, passes it without', () => {
    const f = env({ webgl2: 'caveat' });
    expect(probeWebGL2(f.e, true)).toBe(false);
    expect(probeWebGL2(f.e, false)).toBe(true);
  });

  it('is false without WebGL2, when it throws, or with no canvas', () => {
    expect(probeWebGL2(env({ webgl2: 'none' }).e)).toBe(false);
    expect(probeWebGL2(env({ webgl2: 'throws' }).e)).toBe(false);
    expect(probeWebGL2({})).toBe(false);
  });
});

describe('gateStage', () => {
  it('never creates a WebGL context when a cheap signal already says flat', () => {
    for (const f of [
      { queries: [REDUCED_MOTION_QUERY] },
      { saveData: true },
      { deviceMemory: 2 },
    ] satisfies Fake[]) {
      const x = env({ ...f, webgl2: 'ok' });
      expect(gateStage(x.e, { crashFlag: false })).toBe('flat');
      expect(x.canvases()).toBe(0);
    }
    const crashed = env({ webgl2: 'ok' });
    expect(gateStage(crashed.e, { crashFlag: true })).toBe('flat');
    expect(crashed.canvases()).toBe(0);
  });

  it('probes and decides', () => {
    expect(
      gateStage(env({ webgl2: 'ok', deviceMemory: 8 }).e, { crashFlag: false }),
    ).toBe('3d');
    expect(
      gateStage(env({ webgl2: 'ok', queries: [COARSE_POINTER_QUERY] }).e, {
        crashFlag: false,
      }),
    ).toBe('3d');
    expect(
      gateStage(env({ webgl2: 'ok', deviceMemory: 4 }).e, { crashFlag: false }),
    ).toBe('lite');
    expect(gateStage(env({ webgl2: 'caveat' }).e, { crashFlag: false })).toBe(
      'flat',
    );
    expect(gateStage(env({ webgl2: 'none' }).e, { crashFlag: false })).toBe(
      'flat',
    );
  });

  it('?stage= override: flat never probes; 3d/lite skip the caveat flag', () => {
    const flat = env({ webgl2: 'ok' });
    expect(gateStage(flat.e, { crashFlag: false, override: 'flat' })).toBe(
      'flat',
    );
    expect(flat.canvases()).toBe(0);

    const headless = env({ webgl2: 'caveat', deviceMemory: 2 });
    expect(gateStage(headless.e, { crashFlag: false, override: '3d' })).toBe(
      '3d',
    );
    expect(headless.contexts[0]?.opts.failIfMajorPerformanceCaveat).toBe(false);
    // Reduced motion and the crash flag win over the override, without a probe.
    const reduced = env({ webgl2: 'ok', queries: [REDUCED_MOTION_QUERY] });
    expect(gateStage(reduced.e, { crashFlag: false, override: '3d' })).toBe(
      'flat',
    );
    const crashed = env({ webgl2: 'ok' });
    expect(gateStage(crashed.e, { crashFlag: true, override: '3d' })).toBe(
      'flat',
    );
    expect(reduced.canvases() + crashed.canvases()).toBe(0);
    expect(
      gateStage(env({ webgl2: 'caveat' }).e, {
        crashFlag: false,
        override: 'lite',
      }),
    ).toBe('lite');
    expect(
      gateStage(env({ webgl2: 'none' }).e, {
        crashFlag: false,
        override: '3d',
      }),
    ).toBe('flat');
  });
});

describe('stagePrepaintExpression', () => {
  function run(f: Fake & { crash?: string | null; storageThrows?: boolean }) {
    const storage = {
      getItem: (k: string) => {
        if (f.storageThrows) throw new Error('SecurityError');
        return k === STAGE_CRASH_KEY ? (f.crash ?? null) : null;
      },
    };
    const win = {
      navigator: {
        connection:
          f.saveData === undefined ? undefined : { saveData: f.saveData },
        deviceMemory: f.deviceMemory,
      },
      matchMedia: (q: string) => ({ matches: (f.queries ?? []).includes(q) }),
      sessionStorage: storage,
    };
    return new Function('window', `return ${stagePrepaintExpression()};`)(
      win,
    ) as boolean;
  }

  it('predicts 3D on a clean, capable browser', () => {
    expect(run({})).toBe(true);
    expect(run({ deviceMemory: 4 })).toBe(true);
  });

  it('follows the same cheap rules as the gate', () => {
    expect(run({ queries: [REDUCED_MOTION_QUERY] })).toBe(false);
    expect(run({ queries: [REDUCED_DATA_QUERY] })).toBe(false);
    expect(run({ saveData: true })).toBe(false);
    expect(run({ deviceMemory: 2 })).toBe(false);
    expect(run({ crash: 'boot' })).toBe(false);
    expect(run({ crash: 'crashed' })).toBe(false);
  });

  it('is false when storage throws', () => {
    expect(run({ storageThrows: true })).toBe(false);
  });

  it('is a single expression with no free references beyond window', () => {
    const src = stagePrepaintExpression();
    expect(src.trim().endsWith(';')).toBe(false);
    expect(src).toContain(JSON.stringify(STAGE_CRASH_KEY));
  });
});

describe('frame watchdog', () => {
  it('percentile', () => {
    expect(percentile([], 0.9)).toBe(0);
    const xs = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(percentile(xs, 0.9)).toBe(9);
    expect(percentile(xs, 1)).toBe(10);
  });

  it('trips when p90 of 90 frames is over 34 ms, not before', () => {
    const w = createFrameWatchdog();
    let t = 0;
    let tripped = false;
    for (let k = 0; k < 89; k++) tripped = w.sample(40, (t += 40)) || tripped;
    expect(tripped).toBe(false);
    expect(w.sample(40, (t += 40))).toBe(true);
  });

  it('passes 60 fps and 30 fps (iOS low-power) with a few long frames', () => {
    for (const base of [16.7, 33.3]) {
      const w = createFrameWatchdog();
      let t = 0;
      let tripped = false;
      for (let k = 0; k < 300; k++) {
        const dt = k % 20 === 0 ? 60 : base;
        tripped = w.sample(dt, (t += dt)) || tripped;
      }
      expect(tripped).toBe(false);
    }
  });

  it('skips samples during a hold and ignores stalls', () => {
    const w = createFrameWatchdog({ window: 5 });
    w.hold(0);
    for (let k = 1; k <= 10; k++) expect(w.sample(50, k * 40)).toBe(false); // all inside 500 ms
    for (let k = 0; k < 10; k++) expect(w.sample(5000, 1000 + k)).toBe(false);
    let tripped = false;
    for (let k = 0; k < 5; k++)
      tripped = w.sample(50, 2000 + k * 50) || tripped;
    expect(tripped).toBe(true);
  });

  it('steps 3d -> lite -> flat', () => {
    expect(stepDown('3d')).toBe('lite');
    expect(stepDown('lite')).toBe('flat');
  });
});

describe('stepDownAllowed: a too-slow verdict rebuilds only where no pack is held', () => {
  const at = (
    o: Partial<{
      focus: number;
      spin: number;
      exit: number;
      lap: { rise: number; ret: number; free: boolean; trim: boolean } | null;
    }>,
  ) => stepDownAllowed({ focus: 0, spin: 0, exit: 0, lap: null, ...o });
  it('the row at rest and the free span: now', () => {
    expect(at({})).toBe(true);
    expect(at({ lap: { rise: 0, ret: 0, free: true, trim: false } })).toBe(
      true,
    );
  });
  it('a focused pack, a move into it, the lineup, its exit, the rise: later', () => {
    expect(at({ focus: 3 })).toBe(false);
    expect(at({ focus: 0.2 })).toBe(false);
    expect(at({ spin: 0.5 })).toBe(false);
    expect(at({ exit: 0.1 })).toBe(false);
    expect(at({ lap: { rise: 0.4, ret: 0, free: false, trim: false } })).toBe(
      false,
    );
  });
});
