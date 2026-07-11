// Build the UPDATE statements that move a day of state back so time-gated
// features (daily draw, VIP/commission accrual) re-fire. The daily draw keys
// on a TEXT day column, so a timestamp-only shift is not enough — hence the
// two kinds. Pure string builder; time-shift-exec.mjs runs these via psql.

// Textday shifts are TWO-PHASE. A single in-place `-1 day` UPDATE dies on the
// SECOND shift of a run: reward_draw has UNIQUE (customer_id, draw_day,
// draw_ordinal), and postgres checks non-deferrable uniques row-by-row during
// the bulk UPDATE — a day-2 row moving onto day-1's date collides with the
// day-1 row that hasn't moved yet (hit live 2026-07-11, day 2→3 shift).
// Bouncing every row far forward first (empty region — a run never reaches
// dates 10 years out), then landing on bounce+n back, makes every
// intermediate state collision-free regardless of row order.
export const TEXTDAY_BOUNCE_DAYS = 3650;

export function buildShiftSql(targets, days = 1) {
  const n = Number(days);
  return targets.flatMap((t) => {
    if (t.kind === 'textday') {
      const where = `WHERE "${t.column}" ~ '^\\d{4}-\\d{2}-\\d{2}$'`;
      return [
        `UPDATE "${t.table}" SET "${t.column}" = ` +
          `to_char((to_date("${t.column}", 'YYYY-MM-DD') + ${TEXTDAY_BOUNCE_DAYS}), 'YYYY-MM-DD') ` +
          `${where};`,
        `UPDATE "${t.table}" SET "${t.column}" = ` +
          `to_char((to_date("${t.column}", 'YYYY-MM-DD') - ${TEXTDAY_BOUNCE_DAYS + n}), 'YYYY-MM-DD') ` +
          `${where};`,
      ];
    }
    return [
      `UPDATE "${t.table}" SET "${t.column}" = "${t.column}" - INTERVAL '${n} day';`,
    ];
  });
}
