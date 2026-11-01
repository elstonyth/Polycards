/**
 * When a tab looks for a gate's result: pure, so the timing can be pinned by tests.
 *
 * Every signed-in tab watches, and they all want the same answer in the same
 * minute: the 2026-10-20 outage had exactly that shape. So a tab does not poll from
 * the gate's end. The draw job runs on the minute, so a result cannot exist before
 * the first minute after the end; a tab first looks a few jittered seconds past it,
 * which usually finds the result in one or two reads.
 */
export type WatchedGate = {
  id: string;
  endsAt: number;
  /** When to look next. */
  lookAt: number;
};

const MINUTE_MS = 60_000;
const FIRST_LOOK_MIN_MS = 2_000;
const FIRST_LOOK_SPREAD_MS = 10_000;
const LOOK_AGAIN_MS = 8_000;
const LOOK_AGAIN_SPREAD_MS = 4_000;
/** A gate with no result by now has a late or failing draw: stop looking. The
 *  gate's own page still re-reads it. */
export const WATCH_WINDOW_MS = 5 * MINUTE_MS;
/** A result older than this is no longer a live moment: it waits in Results. */
export const LIVE_MAX_AGE_MS = 2 * MINUTE_MS;

/** First look for a gate ending at `endsAt`. `rand` is 0..1. */
export const firstLookAt = (endsAt: number, rand: number): number =>
  Math.ceil(endsAt / MINUTE_MS) * MINUTE_MS +
  FIRST_LOOK_MIN_MS +
  rand * FIRST_LOOK_SPREAD_MS;

export const nextLookAt = (now: number, rand: number): number =>
  now + LOOK_AGAIN_MS + rand * LOOK_AGAIN_SPREAD_MS;

/** The list after a fresh read of the gates: new ones join, a moved end moves the
 *  look, one this tab already has a result for never comes back, and one past the
 *  window goes. */
export function mergeWatched(
  watched: readonly WatchedGate[],
  gates: readonly { id: string; ends_at: string }[],
  done: ReadonlySet<string>,
  now: number,
  rand: () => number,
): WatchedGate[] {
  const byId = new Map(watched.map((w) => [w.id, w]));
  for (const g of gates) {
    const endsAt = Date.parse(g.ends_at);
    if (Number.isNaN(endsAt) || done.has(g.id)) continue;
    const had = byId.get(g.id);
    if (!had || had.endsAt !== endsAt) {
      byId.set(g.id, { id: g.id, endsAt, lookAt: firstLookAt(endsAt, rand()) });
    }
  }
  return [...byId.values()].filter(
    (w) => !done.has(w.id) && now < w.endsAt + WATCH_WINDOW_MS,
  );
}

/** The gate to look at now: the most overdue, so one stuck undrawn cannot starve
 *  another ending with it (each look pushes its own lookAt back). */
export function dueGate(
  watched: readonly WatchedGate[],
  now: number,
): WatchedGate | null {
  let best: WatchedGate | null = null;
  for (const w of watched) {
    if (w.lookAt <= now && (!best || w.lookAt < best.lookAt)) best = w;
  }
  return best;
}

/** When to wake next, or null with nothing to watch. */
export function nextWake(watched: readonly WatchedGate[]): number | null {
  let at: number | null = null;
  for (const w of watched) {
    if (at === null || w.lookAt < at) at = w.lookAt;
  }
  return at;
}

/** How high the corner card sits on a phone. Some pages keep their main action
 *  fixed above the tab bar, and the card must never cover a way to pay or sell:
 *  the pack page's Open bar, and the action tray on the vault and leaderboard. */
export type CornerLift = 'tabs' | 'bar' | 'tray';

export function cornerLift(pathname: string): CornerLift {
  if (/^\/slots\/[^/]+\/?$/.test(pathname)) return 'bar';
  if (/^\/(vault|leaderboard)(\/|$)/.test(pathname)) return 'tray';
  return 'tabs';
}

const SHOWN_KEY = 'polycards.draws-shown';
const SHOWN_MAX = 40;

/** Draws this browser has already popped up, so a reload or a second tab does not
 *  bring back one the player closed. */
export function readShownDraws(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SHOWN_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(list)
        ? list.filter((v): v is string => typeof v === 'string')
        : [],
    );
  } catch {
    // Storage blocked or junk: a repeat popup is the harmless direction.
    return new Set();
  }
}

export function recordShownDraw(id: string): void {
  try {
    const list = [...readShownDraws(), id].slice(-SHOWN_MAX);
    window.localStorage.setItem(SHOWN_KEY, JSON.stringify(list));
  } catch {
    // See readShownDraws.
  }
}
