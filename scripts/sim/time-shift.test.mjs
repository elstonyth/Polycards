import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShiftSql } from './time-shift.mjs';

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

test('textday column is re-derived as a shifted YYYY-MM-DD string', () => {
  const sql = buildShiftSql(targets, 1)[1];
  assert.match(
    sql,
    /"draw_day" = to_char\(\(to_date\("draw_day", 'YYYY-MM-DD'\) - 1\), 'YYYY-MM-DD'\)/,
  );
  assert.match(sql, /WHERE "draw_day" ~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$'/);
});

test('one statement per target', () => {
  assert.equal(buildShiftSql(targets, 3).length, 2);
  assert.match(buildShiftSql(targets, 3)[0], /INTERVAL '3 day'/);
});
