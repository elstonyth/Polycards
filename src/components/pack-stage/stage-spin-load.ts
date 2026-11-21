/**
 * Pack stage: the one door to the scroll spin's chunk
 * (`stage-spin-kit.ts`), shared by the page (which starts the driver) and the
 * CSS tiles (which pose the row with it). Tiny: the first load carries only
 * this; the chunk loads after hydration, never under reduced motion.
 */
import type { StageSpinKit } from './contract';

let kit: StageSpinKit | null = null;

/** The loaded spin chunk's row functions, or null until it has loaded. */
export const spinKit = (): StageSpinKit | null => kit;

export function loadSpinKit() {
  return import(
    /* webpackChunkName: "pack-stage-spin" */ './stage-spin-kit'
  ).then((m) => {
    kit = m.SPIN_KIT;
    return m;
  });
}
