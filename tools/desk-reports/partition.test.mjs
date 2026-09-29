import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPartition } from './partition.mjs';

const totals = (revenue, payouts = 0) => ({ revenue, payouts });
const NO_ACTIVITY =
  'the window has no activity, so nothing was checked; pick a window with activity, e.g. last_7_days';

test('a partition that adds up passes and shows every part', () => {
  const r = checkPartition(totals(511, 5), [
    ['default', totals(115, 1)],
    ['Partners', totals(140, 2)],
    ['Whales', totals(256, 2)],
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.lines.slice(0, 3), [
    'default: revenue 115',
    'Partners: revenue 140',
    'Whales: revenue 256',
  ]);
  assert.ok(r.lines.includes('ok   revenue: all 511, default + groups 511'));
  assert.ok(r.lines.includes('ok   payouts: all 5, default + groups 5'));
});

test('a total that does not add up fails and names the field', () => {
  const r = checkPartition(totals(100, 10), [
    ['default', totals(60, 10)],
    ['Partners', totals(39.99, 0)],
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL revenue')));
  assert.ok(!r.lines.some((l) => l.startsWith('FAIL payouts')));
});

test('a window with no activity is refused, not passed', () => {
  const r = checkPartition(totals(0, 0), [
    ['default', totals(0, 0)],
    ['Partners', totals(0, 0)],
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.includes(NO_ACTIVITY)));
});

test('empty totals are refused, not passed', () => {
  const r = checkPartition({}, [['default', {}]]);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.includes('no totals to compare')));
});

test('activity in a single part passes with a warning that scoping was not exercised', () => {
  const r = checkPartition(totals(50, 5), [
    ['default', totals(50, 5)],
    ['Partners', totals(0, 0)],
    ['Whales', totals(0, 0)],
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, [
    'only 1 part(s) carry activity, so named-group scoping was not exercised',
  ]);
});

test('parts are summed in whole cents, so float noise is not a mismatch', () => {
  // 0.1 + 0.2 is 0.30000000000000004 as floats.
  const r = checkPartition(totals(0.3), [
    ['default', totals(0.1)],
    ['Partners', totals(0.2)],
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});
