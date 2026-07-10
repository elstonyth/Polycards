// Build the UPDATE statements that move a day of state back so time-gated
// features (daily draw, VIP/commission accrual) re-fire. The daily draw keys
// on a TEXT day column, so a timestamp-only shift is not enough — hence the
// two kinds. Pure string builder; time-shift-exec.mjs runs these via psql.
export function buildShiftSql(targets, days = 1) {
  const n = Number(days);
  return targets.map((t) => {
    if (t.kind === 'textday') {
      return (
        `UPDATE "${t.table}" SET "${t.column}" = ` +
        `to_char((to_date("${t.column}", 'YYYY-MM-DD') - ${n}), 'YYYY-MM-DD') ` +
        `WHERE "${t.column}" ~ '^\\d{4}-\\d{2}-\\d{2}$';`
      );
    }
    return `UPDATE "${t.table}" SET "${t.column}" = "${t.column}" - INTERVAL '${n} day';`;
  });
}
