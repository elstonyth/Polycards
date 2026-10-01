import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, runTool } from './tools.mjs';

const finance = Object.fromEntries(TOOLS.finance.map((t) => [t.name, t]));
const config = {
  baseUrl: 'https://backend.test',
  desk: 'finance',
  key: 'k'.repeat(64),
};

test('the finance desk tools', () => {
  assert.deepEqual(Object.keys(finance), [
    'economy',
    'daily_economy',
    'payments',
    'pack_sales',
    'player',
    'groups',
  ]);
});

test('economy maps a period and group onto the economy route', () => {
  assert.deepEqual(
    finance.economy.request({ period: 'all_time', group: 'default' }),
    {
      path: 'economy',
      params: { from: null, to: null, group: 'default' },
      label: 'all time',
    },
  );
});

test('daily_economy maps onto the daily route', () => {
  const r = finance.daily_economy.request({
    period: 'custom',
    from: '2026-09-01',
    to: '2026-09-07',
  });
  assert.equal(r.path, 'daily');
  assert.deepEqual(r.params, {
    from: '2026-08-31T16:00:00.000Z',
    to: '2026-09-07T16:00:00.000Z',
    group: undefined,
  });
});

const growth = Object.fromEntries(TOOLS.growth.map((t) => [t.name, t]));

test('the growth desk tools', () => {
  assert.deepEqual(Object.keys(growth), [
    'challenge',
    'signups',
    'packs_opened',
    'challenge_poster',
    'brand_logo',
  ]);
  assert.deepEqual(growth.challenge.request({}), {
    path: 'challenge',
    params: {},
  });
  const packs = growth.packs_opened.request({
    period: 'custom',
    from: '2026-09-01',
    group: 'default',
  });
  assert.equal(packs.path, 'packs');
  assert.deepEqual(packs.params, {
    from: '2026-08-31T16:00:00.000Z',
    to: '2026-09-01T16:00:00.000Z',
    group: 'default',
  });
  assert.equal(growth.signups.request({ period: 'today' }).path, 'signups');
});

test('the support desk tools', () => {
  const support = Object.fromEntries(TOOLS.support.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(support), ['order', 'account']);
  assert.deepEqual(support.order.request({ number: '#A1B2C3' }), {
    path: 'order',
    params: { number: '#A1B2C3' },
  });
  assert.deepEqual(support.account.request({ username: 'Ace_Puller' }), {
    path: 'account',
    params: { username: 'Ace_Puller' },
  });
});

test('player asks by username only', () => {
  assert.deepEqual(finance.player.request({ username: 'Ace_Puller' }), {
    path: 'player',
    params: { username: 'Ace_Puller' },
  });
});

test('runTool returns the report with its period, or the error as text', async () => {
  const ok = await runTool(
    finance.economy,
    { period: 'all_time' },
    {
      ...config,
      fetchImpl: async () => new Response('{"totals":{"revenue":1}}'),
    },
  );
  assert.ok(!ok.isError);
  assert.deepEqual(JSON.parse(ok.content[0].text), {
    period: 'all time',
    totals: { revenue: 1 },
  });
  const bad = await runTool(
    finance.economy,
    { period: 'custom' },
    {
      ...config,
      fetchImpl: async () => assert.fail('must not call the backend'),
    },
  );
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /from must be a date/);
});
