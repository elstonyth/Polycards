// Malaysia time (UTC+8, no daylight saving) for the reports: every Polycards
// date boundary is a Malaysia one. One home for the SQL day buckets.

/** The Malaysia calendar day of a timestamptz column, as 'YYYY-MM-DD'. */
export const mytDaySql = (column: string): string =>
  `to_char((${column} AT TIME ZONE 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD')`;

/** The first Malaysia day of the week (ISO, Monday) or month holding a
 *  timestamptz column, as 'YYYY-MM-DD'. */
export const mytPeriodStartSql = (
  unit: 'week' | 'month',
  column: string,
): string =>
  `to_char(date_trunc('${unit}', ${column} AT TIME ZONE 'Asia/Kuala_Lumpur'), 'YYYY-MM-DD')`;
