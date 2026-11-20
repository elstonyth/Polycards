/**
 * Pack stage: the focused pack's address (full-flow plan 2.8). Pure: the
 * focus chunk passes the window's history and location, so the rules run
 * in tests without a browser.
 *
 * - A tap at the row pushes `/slots/<id>` (one entry: Back unfocuses).
 * - A scroll or a key into Front replaces the address (no entry).
 * - Leaving the details downwards puts the base path back: one step back
 *   when the entry is a pushed one of ours, else a replace. Coming back up
 *   into Closing replaces `/slots/<id>` again. The end of the focus at the
 *   row puts the base path back the same way.
 * So the history holds at most one entry from a tap, and none from scrolling
 * or laps. The entry's state records whether it was pushed and the base
 * path, so a resumed entry (Back from the pack page) follows the same rules.
 *
 * A step back is asynchronous: until its popstate arrives nothing else is
 * written, and the address last asked for is written then.
 */

/** The history calls the address uses (the window's in the browser). */
export type FocusHistory = {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url: string): void;
  replaceState(state: unknown, unused: string, url: string): void;
  back(): void;
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
  /** A popstate arrived; true when it was our own step back. */
  popped(): boolean;
  /** The address shows the focused pack. */
  onPack(): boolean;
  /** The current entry's id when it is a focus entry of ours, else null. */
  resumable(): string | null;
  entry(): string | null;
};

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
): FocusAddress {
  let entry: string | null = null;
  let path = '';
  let base = '/';
  /** What the address shows now (our view of it). */
  let shown = false;
  /** Steps back of ours whose popstate has not arrived. */
  let pending = 0;
  /** The address asked for while a step back was pending. */
  let want: boolean | null = null;

  const ours = () => fields(h.state)[FOCUS_MARK] === entry && entry !== null;
  const hide = () => {
    shown = false;
    if (loc().pathname !== path) return;
    if (ours() && fields(h.state)[PUSHED] === true) {
      pending++;
      h.back();
    } else h.replaceState(null, '', base);
  };
  const reveal = () => {
    shown = true;
    if (loc().pathname === path && ours()) return;
    h.replaceState({ [FOCUS_MARK]: entry, [BASE]: base }, '', path);
  };

  const address: FocusAddress = {
    enter(id, how, e) {
      entry = e;
      path = packPath(id);
      want = null;
      if (how === 'resume') {
        const b = fields(h.state)[BASE];
        base = typeof b === 'string' ? b : '/';
        shown = loc().pathname === path;
        return;
      }
      const l = loc();
      base = l.pathname + l.search;
      const state: Record<string, unknown> = {
        [FOCUS_MARK]: e,
        [BASE]: base,
      };
      if (how === 'tap') {
        state[PUSHED] = true;
        h.pushState(state, '', path);
      } else h.replaceState(state, '', path);
      shown = true;
    },
    show(on) {
      if (entry === null) return;
      if (pending > 0) {
        want = on;
        return;
      }
      if (on === shown) return;
      if (on) reveal();
      else hide();
    },
    end() {
      address.show(false);
      entry = null;
    },
    forget() {
      entry = null;
      shown = false;
      want = null;
    },
    popped() {
      if (pending === 0) {
        shown = entry !== null && loc().pathname === path;
        return false;
      }
      pending--;
      if (pending === 0 && want !== null) {
        const w = want;
        want = null;
        if (entry !== null) {
          if (w) reveal();
          else shown = false;
        }
      }
      return true;
    },
    onPack: () => loc().pathname === path && path !== '',
    resumable() {
      const mark = fields(h.state)[FOCUS_MARK];
      return typeof mark === 'string' && SLOT_PATH.test(loc().pathname)
        ? mark
        : null;
    },
    entry: () => entry,
  };
  return address;
}
