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
  assert.deepEqual(Object.keys(finance), ['economy']);
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
