import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod } from './periods.mjs';

// Wednesday 30 Sep 2026, 10:00 Malaysia time.
const NOW = Date.parse('2026-09-30T02:00:00.000Z');
const range = (period, extra = {}, now = NOW) => {
  const r = resolvePeriod(period, extra, now);
  return [r.from, r.to];
};

test('today and yesterday are Malaysia calendar days', () => {
  assert.deepEqual(range('today'), [
    '2026-09-29T16:00:00.000Z',
    '2026-09-30T16:00:00.000Z',
  ]);
  assert.deepEqual(range('yesterday'), [
    '2026-09-28T16:00:00.000Z',
    '2026-09-29T16:00:00.000Z',
  ]);
});

test('just after Malaysia midnight is already the next day', () => {
  // 00:30 on 29 Sep in Malaysia is still 28 Sep in UTC.
  assert.deepEqual(range('today', {}, Date.parse('2026-09-28T16:30:00.000Z')), [
    '2026-09-28T16:00:00.000Z',
    '2026-09-29T16:00:00.000Z',
  ]);
});

test('weeks start on Monday', () => {
  assert.deepEqual(range('this_week'), [
    '2026-09-27T16:00:00.000Z',
    '2026-10-04T16:00:00.000Z',
  ]);
  assert.deepEqual(range('last_week'), [
    '2026-09-20T16:00:00.000Z',
    '2026-09-27T16:00:00.000Z',
  ]);
  // Monday 28 Sep: the week starts that day. Sunday 4 Oct: it started six days earlier.
  assert.equal(
    resolvePeriod('this_week', {}, Date.parse('2026-09-28T01:00:00.000Z')).from,
    '2026-09-27T16:00:00.000Z',
  );
  assert.equal(
    resolvePeriod('this_week', {}, Date.parse('2026-10-04T01:00:00.000Z')).from,
    '2026-09-27T16:00:00.000Z',
  );
});

test('month edges follow the Malaysia calendar', () => {
  assert.deepEqual(range('this_month'), [
    '2026-08-31T16:00:00.000Z',
    '2026-09-30T16:00:00.000Z',
  ]);
  assert.deepEqual(range('last_month'), [
    '2026-07-31T16:00:00.000Z',
    '2026-08-31T16:00:00.000Z',
  ]);
  // 00:30 on 1 March in Malaysia is still February in UTC.
  const march1 = Date.parse('2026-02-28T16:30:00.000Z');
  assert.deepEqual(range('this_month', {}, march1), [
    '2026-02-28T16:00:00.000Z',
    '2026-03-31T16:00:00.000Z',
  ]);
  assert.deepEqual(range('last_month', {}, march1), [
    '2026-01-31T16:00:00.000Z',
    '2026-02-28T16:00:00.000Z',
  ]);
  // January's last month is December of the year before.
  assert.equal(
    resolvePeriod('last_month', {}, Date.parse('2026-01-15T04:00:00.000Z'))
      .from,
    '2025-11-30T16:00:00.000Z',
  );
});

test('rolling windows end now, like the dashboard Weekly and Monthly tabs', () => {
  assert.deepEqual(range('last_7_days'), [
    '2026-09-23T02:00:00.000Z',
    '2026-09-30T02:00:00.000Z',
  ]);
  assert.deepEqual(range('last_30_days'), [
    '2026-08-31T02:00:00.000Z',
    '2026-09-30T02:00:00.000Z',
  ]);
});

test('all_time has no bounds', () => {
  assert.deepEqual(resolvePeriod('all_time', {}, NOW), {
    from: null,
    to: null,
    label: 'all time',
  });
});

test('custom takes Malaysia dates, with to included', () => {
  assert.deepEqual(range('custom', { from: '2026-09-01', to: '2026-09-15' }), [
    '2026-08-31T16:00:00.000Z',
    '2026-09-15T16:00:00.000Z',
  ]);
  assert.deepEqual(range('custom', { from: '2026-09-29' }), [
    '2026-09-28T16:00:00.000Z',
    '2026-09-29T16:00:00.000Z',
  ]);
  assert.throws(
    () => resolvePeriod('custom', { from: '2026-02-30' }, NOW),
    /not a real date/,
  );
  assert.throws(
    () => resolvePeriod('custom', { from: '29/09/2026' }, NOW),
    /like 2026-09-29/,
  );
  assert.throws(
    () =>
      resolvePeriod('custom', { from: '2026-09-15', to: '2026-09-01' }, NOW),
    /on or before/,
  );
  assert.throws(() => resolvePeriod('custom', {}, NOW), /from must be a date/);
  assert.throws(() => resolvePeriod('fortnight', {}, NOW), /Unknown period/);
});

test('labels spell out the Malaysia-time window', () => {
  assert.equal(
    resolvePeriod('today', {}, NOW).label,
    'today (Malaysia time 2026-09-30 00:00 to 2026-10-01 00:00, end excluded)',
  );
});
