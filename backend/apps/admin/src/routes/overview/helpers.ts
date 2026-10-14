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
export const todayMyt = () =>
  new Date(Date.now() + MYT_MS).toISOString().slice(0, 10);

/** A section whose endpoint refuses this role hides instead of erroring. */
export const isForbidden = (err: unknown): boolean => {
  const status = httpStatus(err);
  return status === 401 || status === 403;
};
