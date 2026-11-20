/**
 * Pack stage, step 2: the spin back print queue's policy (plan-step2.md
 * 10.5, 10.7 and the "spin gives way" ruling in 10.14). Pure bookkeeping, no
 * three.js, no DOM, no clock: the runtime owns the handles and asks this
 * module what to print, when, and what to free.
 *
 * Rules held here (each has a unit test):
 * - A back with no pull odds is never printed (no-odds rule): that pack stays
 *   in lean mode.
 * - Prints run only when the caller says the stage is idle (spin settled,
 *   no focus, no swap, float-in done, panel near the pin), ONE at a time,
 *   nearest the centre first, and only for packs whose handle is resident.
 * - A new set (category, type or language change) frees every spin back
 *   FIRST, before the caller prefetches the coming row; the new row spins
 *   front-only until its backs are reprinted at idle.
 * - `setBacks(null)` (focus start, the 60 s release, context loss, unmount)
 *   frees them all.
 * - A changed back (the 60 s poll: price, buyback, odds) is reprinted after
 *   300 ms of quiet; the old print stays drawn until then.
 */
import type { PackBackDetails, StageSpinBack } from './contract';

/** Reprint debounce for a changed back (section 4). */
export const BACK_REPRINT_DEBOUNCE_MS = 300;

/** A back can be printed only with pull odds to print (no-odds rule, section 4). */
export function isPrintableBack(
  d: PackBackDetails | null | undefined,
): d is PackBackDetails & { odds: NonNullable<PackBackDetails['odds']> } {
  return !!d && Array.isArray(d.odds) && d.odds.length > 0;
}

/** What a back prints, as a comparable key (price, product line, odds, buyback). */
export function backPrintKey(d: PackBackDetails | null | undefined): string {
  if (!isPrintableBack(d)) return '';
  return JSON.stringify([
    d.price,
    d.productLine,
    d.odds.map((r) => [r.label, r.chance]),
    d.buyback ? [d.buyback.headline, d.buyback.rule] : null,
  ]);
}

export type SpinBackStatus = 'none' | 'printing' | 'ready';

type Entry = {
  id: string;
  details: PackBackDetails | null;
  key: string;
  /** Key of the back on the handle now ('' = none). */
  printedKey: string;
  printingKey: string | null;
  dueAt: number;
};

export type SpinBackNext = {
  now: number;
  /** Spin settled, no focus, no swap, float-in done, panel near the pin. */
  idle: boolean;
  /** The handle is loaded (a back lives on its pack's handle). */
  resident(id: string): boolean;
  /** Sort key: distance from the (wrapped) centre; lower prints first. */
  distance(id: string): number;
};

export interface SpinBackQueue {
  /**
   * The provider's `setSpinBacks(list)`. Returns the ids whose backs the
   * caller must free now (`hideBack`), before anything else is loaded.
   */
  setBacks(list: readonly StageSpinBack[] | null, now: number): string[];
  /** The id to print now, or null. Marks it printing. */
  next(o: SpinBackNext): string | null;
  /** The print for `id` finished (ok) or failed. */
  printed(id: string, ok: boolean): void;
  /** The pack's handle was disposed (residency): its back went with it. */
  dropped(id: string): void;
  status(id: string): SpinBackStatus;
  /** The details to print for `id` (only ever printable ones). */
  details(id: string): PackBackDetails | null;
  /** Ids with a back on the handle now. */
  ready(): string[];
  /** Something is still owed a print. */
  pending(): boolean;
}

function sameIds(a: readonly { id: string }[], b: Map<string, Entry>): boolean {
  if (a.length !== b.size) return false;
  return a.every((e) => b.has(e.id));
}

export function createSpinBackQueue(): SpinBackQueue {
  let entries = new Map<string, Entry>();

  const held = (e: Entry) => e.printedKey !== '' || e.printingKey !== null;

  return {
    setBacks(list, now) {
      const free: string[] = [];
      if (!list || !sameIds(list, entries)) {
        // a new set or none: free every back first
        for (const e of entries.values()) if (held(e)) free.push(e.id);
        entries = new Map();
        for (const b of list ?? []) {
          entries.set(b.id, {
            id: b.id,
            details: isPrintableBack(b.details) ? b.details : null,
            key: backPrintKey(b.details),
            printedKey: '',
            printingKey: null,
            dueAt: now,
          });
        }
        return free;
      }
      for (const b of list) {
        const e = entries.get(b.id);
        if (!e) continue;
        const key = backPrintKey(b.details);
        if (key === e.key) continue;
        e.key = key;
        e.details = isPrintableBack(b.details) ? b.details : null;
        if (key === '') {
          // odds gone: never print it; drop the old back (lean mode)
          if (held(e)) free.push(e.id);
          e.printedKey = '';
          e.printingKey = null;
        } else {
          e.dueAt = now + BACK_REPRINT_DEBOUNCE_MS;
        }
      }
      return free;
    },
    next(o) {
      if (!o.idle) return null;
      for (const e of entries.values()) if (e.printingKey !== null) return null;
      let best: Entry | null = null;
      let bestD = Infinity;
      for (const e of entries.values()) {
        if (e.key === '' || e.printedKey === e.key) continue;
        if (e.dueAt > o.now || !o.resident(e.id)) continue;
        const d = o.distance(e.id);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      if (!best) return null;
      best.printingKey = best.key;
      return best.id;
    },
    printed(id, ok) {
      const e = entries.get(id);
      if (!e || e.printingKey === null) return;
      if (ok && e.printingKey === e.key) e.printedKey = e.key;
      e.printingKey = null;
    },
    dropped(id) {
      const e = entries.get(id);
      if (!e) return;
      e.printedKey = '';
      e.printingKey = null;
    },
    status(id) {
      const e = entries.get(id);
      if (!e) return 'none';
      if (e.printingKey !== null) return 'printing';
      return e.printedKey !== '' ? 'ready' : 'none';
    },
    details(id) {
      return entries.get(id)?.details ?? null;
    },
    ready() {
      return [...entries.values()]
        .filter((e) => e.printedKey !== '')
        .map((e) => e.id);
    },
    pending() {
      for (const e of entries.values())
        if (e.key !== '' && e.printedKey !== e.key) return true;
      return false;
    },
  };
}

/** The queue's idle gate (10.5): never while the spin moves, in focus, mid-swap or mid-float-in. */
export function spinPrintIdle(o: {
  settled: boolean;
  focus: number;
  swap: number;
  intro: number;
  panelNear: boolean;
  variant: 'paged' | 'free' | 'tip';
}): boolean {
  return (
    o.variant !== 'tip' &&
    o.settled &&
    !(o.focus > 0) &&
    !(o.swap > 0) &&
    o.intro >= 1 &&
    o.panelNear
  );
}
