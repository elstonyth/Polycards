import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShiftSql, TEXTDAY_BOUNCE_DAYS } from './time-shift.mjs';

const targets = [
  { table: 'credit_transaction', column: 'created_at', kind: 'timestamp' },
  { table: 'reward_draw', column: 'draw_day', kind: 'textday' },
];

test('timestamp column shifts back by an interval', () => {
  const [sql] = buildShiftSql(targets, 1);
  assert.match(
    sql,
    /UPDATE "credit_transaction" SET "created_at" = "created_at" - INTERVAL '1 day'/,
  );
});

// A single in-place -1 UPDATE transiently collides with the UNIQUE
// (customer_id, draw_day, draw_ordinal) constraint on the SECOND shift of a
// run: day-2 rows moving to day-1's date hit day-1 rows that haven't moved
// yet (postgres checks non-deferrable uniques row-by-row). The textday shift
// therefore bounces far forward first, then lands on the final date — the
// bounce region is empty, so no intermediate state ever collides.
test('textday column shifts via a collision-free two-phase bounce', () => {
  const [, up, down] = buildShiftSql(targets, 1);
  assert.match(
    up,
    new RegExp(
      `"draw_day" = to_char\\(\\(to_date\\("draw_day", 'YYYY-MM-DD'\\) \\+ ${TEXTDAY_BOUNCE_DAYS}\\), 'YYYY-MM-DD'\\)`,
    ),
  );
  assert.match(
    down,
    new RegExp(
      `"draw_day" = to_char\\(\\(to_date\\("draw_day", 'YYYY-MM-DD'\\) - ${TEXTDAY_BOUNCE_DAYS + 1}\\), 'YYYY-MM-DD'\\)`,
    ),
  );
  // Both phases only touch rows that look like a plain date.
  assert.match(up, /WHERE "draw_day" ~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$'/);
  assert.match(down, /WHERE "draw_day" ~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$'/);
});

test('net textday shift equals the requested days', () => {
  const [, up, down] = buildShiftSql(targets, 3);
  assert.match(up, new RegExp(`\\+ ${TEXTDAY_BOUNCE_DAYS}\\)`));
  assert.match(down, new RegExp(`- ${TEXTDAY_BOUNCE_DAYS + 3}\\)`));
});

test('one statement per timestamp target, two per textday target', () => {
  const sql = buildShiftSql(targets, 3);
  assert.equal(sql.length, 3);
  assert.match(sql[0], /INTERVAL '3 day'/);
});
