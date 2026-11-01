import { CHOMP_STEP, LAST_STEP, WAVE_STEPS, type ArenaRun } from './engine';

// The show's clock, in ms from its start: twenty seconds, whatever the gate's size
// (boss 2026-11-01). The battle runs close to real time, then drops into slow
// motion for the last moments, so the last eat lands where the music would.
export const SHOW_MS = 20_000;
const INTRO_MS = 1_200;
const SLOW_FROM_MS = 15_400;
const LAST_EAT_MS = 17_700;
/** The winner is told here. */
export const REVEAL_MS = 18_300;
/** Steps the slow motion covers. */
const SLOW_STEPS = LAST_STEP - CHOMP_STEP;

/** Where the battle is at a moment of the show, in steps, fractional. */
export function stepAt(t: number, lastStep: number): number {
  if (t <= INTRO_MS) return 0;
  const slowFrom = Math.max(0, lastStep - SLOW_STEPS);
  if (t < SLOW_FROM_MS) {
    return (slowFrom * (t - INTRO_MS)) / (SLOW_FROM_MS - INTRO_MS);
  }
  if (t < LAST_EAT_MS) {
    return (
      slowFrom +
      ((lastStep - slowFrom) * (t - SLOW_FROM_MS)) /
        (LAST_EAT_MS - SLOW_FROM_MS)
    );
  }
  return lastStep;
}

export type ArenaPhase =
  'opening' | 'boosters' | 'frenzy' | 'closing' | 'final' | 'winner';

const FRENZY_STEP = WAVE_STEPS[2];
const CLOSING_STEP = WAVE_STEPS[4];

export function phaseAt(t: number, run: ArenaRun): ArenaPhase {
  if (t >= LAST_EAT_MS) return 'winner';
  const step = stepAt(t, run.lastStep);
  if (step >= run.finalStep) return 'final';
  if (step >= CLOSING_STEP) return 'closing';
  if (step >= FRENZY_STEP) return 'frenzy';
  return t < INTRO_MS ? 'opening' : 'boosters';
}

/** The moment of the show a step plays at: for tests, and to line a sound up. */
export const LAST_EAT_AT = LAST_EAT_MS;
