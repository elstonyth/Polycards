import type { FocusHistory, FocusLocation } from './stage-focus-address';
import {
  BASE,
  FOCUS_MARK,
  PUSHED,
  fields,
  packPath,
} from './stage-focus-marks';

/**
 * A document load onto pack `id`'s own address, served as the flow page with
 * `?focus=<id>` (a shared link, a reload): puts the pack's address back and
 * marks the entry in place as a focus entry, so the flow resumes the pack on
 * it as it resumes an entry of its own. A fresh mark per load, so a load opens
 * on Front (no saved stop), and never a pushed one: going up from Front then
 * puts the base path in place, and Back leaves the page as after any direct
 * entry. Back or Forward onto an entry that already has a mark keeps it (and
 * its saved stop). Returns the entry's mark, or null when this load is not
 * one onto `id`'s address.
 */
export function startEntry(
  h: Pick<FocusHistory, 'state' | 'replaceState'>,
  l: FocusLocation,
  o: {
    id: string;
    /** The page that shows the row (when the entry names none). */
    base: string;
    /** The navigation type of this load (PerformanceNavigationTiming). */
    navigation: string | undefined;
    now: number;
  },
): string | null {
  const q = new URLSearchParams(l.search);
  if (!o.id || q.get('focus') !== o.id) return null;
  q.delete('focus');
  const rest = q.toString();
  const url = packPath(o.id) + (rest ? `?${rest}` : '');
  const st = fields(h.state);
  const mark = st[FOCUS_MARK];
  const next: Record<string, unknown> = { ...st };
  let kept: string | null = null;
  // the entry before this one belongs to another document now: never a
  // pushed entry of this page's
  delete next[PUSHED];
  if (o.navigation === 'back_forward' && typeof mark === 'string') kept = mark;
  else next[FOCUS_MARK] = `${o.id}:start:${Math.round(o.now)}`;
  if (typeof st[BASE] !== 'string') next[BASE] = o.base;
  h.replaceState(next, '', url);
  return kept ?? (next[FOCUS_MARK] as string);
}
