import { httpStatus, type StatsRange } from '../../lib/admin-rest';

export const RANGES: StatsRange[] = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'last_month',
  'custom',
];

// The Dashboard opens on the range the operator last picked (this browser),
// else Today.
const RANGE_KEY = 'pc-dashboard-range';

export const parseSavedRange = (raw: string | null): StatsRange =>
  RANGES.includes(raw as StatsRange) ? (raw as StatsRange) : 'today';

export const savedRange = (): StatsRange => {
  try {
    return parseSavedRange(window.localStorage.getItem(RANGE_KEY));
  } catch {
    return 'today';
  }
};

export const saveRange = (range: StatsRange): void => {
  try {
    window.localStorage.setItem(RANGE_KEY, range);
  } catch {
    // Private mode or blocked storage: the pick still holds for this visit.
  }
};

// The backend's windows are MYT (fixed UTC+8). Shift, then read the UTC
// fields, so the text is MYT whatever timezone the viewer's browser is in.
const MYT_MS = 8 * 3_600_000;
const mytText = (iso: string) =>
  new Date(Date.parse(iso) + MYT_MS)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
export const windowText = (w: { from: string; to: string }) =>
  `${mytText(w.from)} – ${mytText(w.to)}`;

// Fixed names: en-GB's Intl writes "Sept" on newer ICU builds.
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** The MYT days a half-open window covers: "1 Oct – 14 Oct 2026". */
export const dayRangeText = (w: { from: string; to: string }) => {
  const a = new Date(Date.parse(w.from) + MYT_MS);
  const b = new Date(Date.parse(w.to) - 1 + MYT_MS);
  const day = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  const ya = a.getUTCFullYear();
  const yb = b.getUTCFullYear();
  if (ya !== yb) return `${day(a)} ${ya} – ${day(b)} ${yb}`;
  return day(a) === day(b) ? `${day(b)} ${yb}` : `${day(a)} – ${day(b)} ${yb}`;
};
export const todayMyt = () =>
  new Date(Date.now() + MYT_MS).toISOString().slice(0, 10);

/** A section whose endpoint refuses this role hides instead of erroring. */
export const isForbidden = (err: unknown): boolean => {
  const status = httpStatus(err);
  return status === 401 || status === 403;
};

/** How often the Dashboard refreshes itself while its tab is visible. */
export const LIVE_MS = 30_000;
