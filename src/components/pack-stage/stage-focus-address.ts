/**
 * Pack stage: the focused pack's address (full-flow plan 2.8). Pure: the
 * focus chunk passes the window's history and location, so the rules run
 * in tests without a browser.
 *
 * - A tap at the row pushes `/slots/<id>` (one entry: Back unfocuses).
 * - A scroll or a key into Front replaces the address (no entry).
 * - Leaving the details downwards puts the base path back: one step back
 *   when the entry is a pushed one of ours, else a replace. Coming back up
 *   into Closing steps forward onto that pushed entry again when it is still
 *   the next one (so browser Back still unfocuses), else replaces
 *   `/slots/<id>`. The end of the focus at the row puts the base path back
 *   the same way.
 * So the history holds at most one entry from a tap, and none from scrolling
 * or laps. The entry's state records whether it was pushed and the base
 * path, so a resumed entry (Back from the pack page) follows the same rules.
 *
 * A step back or forward is asynchronous: until its popstate arrives nothing
 * else is written (a new focus included, which keeps the base path it had);
 * once the last one has arrived, the address is brought to what was last
 * asked for.
 */

/** The history calls the address uses (the window's in the browser). */
export type FocusHistory = {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url: string): void;
  replaceState(state: unknown, unused: string, url: string): void;
  back(): void;
  forward(): void;
};

export type FocusLocation = { pathname: string; search: string };

/** How the focus began: a tap, a scroll or key, or a resumed entry. */
export type FocusEntryKind = 'tap' | 'scroll' | 'resume';

export type FocusAddress = {
  /** The focus began: write the pack's address (a resumed entry writes nothing). */
  enter(id: string, how: FocusEntryKind, entry: string): void;
  /** The page is in the details (true) or has left them downwards (false). */
  show(on: boolean): void;
  /** The focus ended at the row: the base path again. */
  end(): void;
  /** The address already moved (browser Back): forget the entry, write nothing. */
  forget(): void;
  /** A popstate arrived; true when it was our own step. */
  popped(): boolean;
  /** The address shows the focused pack. */
  onPack(): boolean;
  /** The current entry's id when it is a focus entry of ours, else null. */
  resumable(): string | null;
  /**
   * No focus runs and nothing of ours is pending, yet the address shows a
   * focus entry of ours (browser Forward brought it back during a leave):
   * the page resumes it.
   */
  strayed(): boolean;
  entry(): string | null;
};

/**
 * A step forward of ours that has not landed by then never will (another
 * script pushed an entry meanwhile, which fires no popstate): the address
 * is replaced instead [ours].
 */
export const FOCUS_STEP_MS = 1000;

/** The marks written into the entry's state. */
export const FOCUS_MARK = '__flow';
const PUSHED = '__flowPushed';
const BASE = '__flowBase';

const SLOT_PATH = /^\/slots\/([^/]+)\/?$/;

const fields = (st: unknown): Record<string, unknown> =>
  st && typeof st === 'object' ? (st as Record<string, unknown>) : {};

/** The path of pack `id`. */
export const packPath = (id: string) => `/slots/${encodeURIComponent(id)}`;

export function createFocusAddress(
  h: FocusHistory,
  loc: () => FocusLocation,
  after?: (ms: number, fn: () => void) => () => void,
): FocusAddress {
  let entry: string | null = null;
  /** The focus ended while a step was pending: the base path once it lands. */
  let ended = false;
  let path = '';
  let base = '/';
  /** What the address shows now (our view of it). */
  let shown = false;
  /** Steps back or forward of ours whose popstate has not arrived. */
  let pending = 0;
  /** The address asked for while a step was pending. */
  let want: boolean | null = null;
  /** A new focus's first write, held until the pending steps land. */
  let queued: 'tap' | 'scroll' | null = null;
  /**
   * The next entry is this focus's pushed entry (we stepped back from it and
   * nothing has changed the history since): coming back up steps onto it.
   */
  let forward: string | null = null;
  /** The pending step forward's time limit (null: none pending). */
  let disarmStep: (() => void) | null = null;

  const ours = () => fields(h.state)[FOCUS_MARK] === entry && entry !== null;
  const write = (how: 'tap' | 'scroll') => {
    const state: Record<string, unknown> = {
      [FOCUS_MARK]: entry,
      [BASE]: base,
    };
    forward = null;
    if (how === 'tap') {
      state[PUSHED] = true;
      h.pushState(state, '', path);
    } else h.replaceState(state, '', path);
    shown = true;
  };
  const hide = () => {
    shown = false;
    // a link opened another page meanwhile: never step back off it
    if (loc().pathname !== path) return;
    if (ours() && fields(h.state)[PUSHED] === true) {
      pending++;
      forward = entry;
      h.back();
    } else h.replaceState(null, '', base);
  };
  const reveal = () => {
    shown = true;
    if (loc().pathname === path && ours()) return;
    if (forward !== null && forward === entry) {
      forward = null;
      pending++;
      const off = after?.(FOCUS_STEP_MS, () => {
        if (disarmStep !== off) return;
        // it never landed: as if it had, then the address is written in place
        disarmStep = null;
        pending = Math.max(0, pending - 1);
        if (pending === 0) settle();
      });
      disarmStep = off ?? null;
      h.forward();
      return;
    }
    h.replaceState({ [FOCUS_MARK]: entry, [BASE]: base }, '', path);
  };
  /** The last pending step has landed: the address as last asked for. */
  const settle = () => {
    const w = want;
    want = null;
    if (entry === null) return;
    const target = ended ? false : (w ?? (queued !== null ? true : shown));
    if (queued !== null) {
      const how = queued;
      queued = null;
      if (target) write(how);
      else shown = false;
    } else {
      const actual = loc().pathname === path && ours();
      if (target && !actual) reveal();
      else if (!target && actual) hide();
      else shown = actual;
    }
    if (ended && pending === 0) {
      entry = null;
      ended = false;
    }
  };

  const address: FocusAddress = {
    enter(id, how, e) {
      entry = e;
      ended = false;
      path = packPath(id);
      want = null;
      queued = null;
      forward = null;
      if (how === 'resume') {
        const b = fields(h.state)[BASE];
        base = typeof b === 'string' ? b : '/';
        shown = loc().pathname === path;
        return;
      }
      if (pending > 0) {
        // the last focus's step back has not landed: the location is not
        // the base path yet, so the base path stays as it was, and the
        // write waits for the step to land
        queued = how;
        shown = false;
        return;
      }
      const l = loc();
      base = l.pathname + l.search;
      write(how);
    },
    show(on) {
      if (entry === null || ended) return;
      if (pending > 0) {
        want = on;
        return;
      }
      if (on === shown) return;
      if (on) reveal();
      else hide();
    },
    end() {
      if (entry === null) return;
      if (pending > 0) {
        ended = true;
        return;
      }
      address.show(false);
      if (pending > 0) ended = true;
      else entry = null;
    },
    forget() {
      entry = null;
      ended = false;
      shown = false;
      want = null;
      queued = null;
      forward = null;
    },
    popped() {
      if (pending === 0) {
        // the visitor moved the history: the next entry is not known now
        forward = null;
        shown = entry !== null && loc().pathname === path;
        return false;
      }
      pending--;
      disarmStep?.();
      disarmStep = null;
      if (pending === 0) settle();
      return true;
    },
    onPack: () => loc().pathname === path && path !== '',
    resumable() {
      const mark = fields(h.state)[FOCUS_MARK];
      return typeof mark === 'string' && SLOT_PATH.test(loc().pathname)
        ? mark
        : null;
    },
    strayed: () =>
      entry === null && pending === 0 && address.resumable() !== null,
    entry: () => (ended ? null : entry),
  };
  return address;
}
