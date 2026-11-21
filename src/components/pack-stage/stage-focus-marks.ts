/**
 * The marks the focused pack's address writes into a history entry's state,
 * and the pack's path. Kept apart from the address itself so the page's first
 * load can mark an entry (stage-focus-entry) without carrying the address.
 */

/** The entry is a focus entry; its value names the entry. */
export const FOCUS_MARK = '__flow';
/** The entry was pushed by a tap (one step back unfocuses). */
export const PUSHED = '__flowPushed';
/** The page that shows the row, for going back to it. */
export const BASE = '__flowBase';

/** An entry's state as a record (empty when it holds none). */
export const fields = (st: unknown): Record<string, unknown> =>
  st && typeof st === 'object' ? (st as Record<string, unknown>) : {};

/** The path of pack `id`. */
export const packPath = (id: string) => `/slots/${encodeURIComponent(id)}`;
