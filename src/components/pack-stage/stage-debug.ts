/**
 * `?debug=1` (the preview): `window.__packStage` for QA scripts. Loaded on
 * demand by the provider, so the first load never carries it.
 */
import type { StageRuntimeStats, StageState } from './contract';

/** The engine members the debug object reads (the provider's own fields). */
type EngineView = {
  snap: { mode: string; ready: boolean };
  tier: string;
  layout: unknown;
  drawn: readonly string[];
  runtime: unknown;
  running: boolean;
  state: StageState;
  stats(): StageRuntimeStats | null;
  wake(): void;
  poke(): void;
};

/** Sets `window.__packStage`; returns its removal. */
export function exposeStageDebug(engine: unknown): () => void {
  const e = engine as EngineView;
  const rt = () =>
    e.runtime as {
      debug?: () => unknown;
      debugFullCanvas?: (v: boolean) => void;
    } | null;
  (window as unknown as Record<string, unknown>).__packStage = {
    mode: () => e.snap.mode,
    ready: () => e.snap.ready,
    tier: () => e.tier,
    layout: () => e.layout,
    live: () => [...e.drawn],
    fullCanvas: (on: boolean) => {
      rt()?.debugFullCanvas?.(on);
      e.poke();
    },
    runtime: () => rt()?.debug?.() ?? null,
    running: () => e.running,
    state: e.state,
    stats: () => e.stats(),
    wake: () => e.wake(),
  };
  return () => {
    delete (window as unknown as Record<string, unknown>).__packStage;
  };
}
