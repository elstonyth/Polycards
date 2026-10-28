const MYT_MS = 8 * 3_600_000;

/** The Malaysia calendar day of an instant, 'YYYY-MM-DD' (MYT is a fixed
 *  UTC+8, so shift and read the UTC date). */
export const mytDay = (iso: string): string =>
  new Date(Date.parse(iso) + MYT_MS).toISOString().slice(0, 10);

/**
 * Consecutive rows grouped under their MYT day, in the order given. Never
 * re-sorts: a list sorted by type can show the same day twice, and merging
 * those would silently reorder what the operator asked for.
 */
export function groupByDay<T extends { occurred_at: string }>(
  rows: T[],
): { day: string; rows: T[] }[] {
  const out: { day: string; rows: T[] }[] = [];
  for (const r of rows) {
    const day = mytDay(r.occurred_at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else out.push({ day, rows: [r] });
  }
  return out;
}
