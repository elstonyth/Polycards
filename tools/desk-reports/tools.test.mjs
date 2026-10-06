import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS, TOOLS, runTool } from './tools.mjs';

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
    'tasks',
    'top_pulls',
    'challenge_results',
    'challenge_poster',
    'challenge_results_poster',
    'challenge_stages_poster',
    'brand_poster',
    'achievements_poster',
    'tasks_poster',
    'top_pulls_poster',
    'brand_logo',
  ]);
  // The Monday posts: last week's results, every stage, the week's tasks.
  assert.deepEqual(growth.challenge_results.request({}), {
    path: 'challenge-results',
    params: {},
  });
  assert.deepEqual(growth.challenge_results_poster.request({}), {
    path: 'challenge-results-poster',
    params: {},
    as: 'image',
    artOf: 'podium rank',
  });
  // The week's second image: ranks 4-10.
  assert.deepEqual(
    growth.challenge_results_poster.request({ part: 'rest' }).params,
    { part: 'rest' },
  );
  assert.deepEqual(growth.challenge_stages_poster.request({}), {
    path: 'challenge-stages-poster',
    params: {},
    as: 'image',
    artOf: 'stage:rank',
  });
  assert.deepEqual(
    growth.challenge_stages_poster.request({ week: 'next' }).params,
    { week: 'next' },
  );
  assert.deepEqual(growth.tasks_poster.request({}), {
    path: 'tasks-poster',
    params: {},
    as: 'image',
    artOf: 'prize',
  });
  assert.deepEqual(growth.tasks.request({}), { path: 'tasks', params: {} });
  assert.deepEqual(growth.top_pulls.request({ day: '2026-10-03', limit: 5 }), {
    path: 'top-pulls',
    params: { day: '2026-10-03', limit: 5 },
  });
  assert.deepEqual(growth.top_pulls_poster.request({}), {
    path: 'top-pulls-poster',
    params: { day: undefined, limit: undefined },
    as: 'image',
    artOf: 'rank',
  });
  assert.deepEqual(growth.challenge.request({}), {
    path: 'challenge',
    params: { week: undefined },
  });
  // The queued edition (the next challenge) for the report and the poster.
  assert.deepEqual(growth.challenge.request({ week: 'next' }).params, {
    week: 'next',
  });
  assert.equal(
    growth.challenge_poster.request({ week: 'next' }).params.week,
    'next',
  );
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

test('the store desk tools', () => {
  const store = Object.fromEntries(TOOLS.store.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(store), ['packs', 'pack', 'low_stock']);
  assert.deepEqual(store.packs.request({}), { path: 'packs', params: {} });
  assert.deepEqual(store.pack.request({ slug: 'silver-pack' }), {
    path: 'pack',
    params: { slug: 'silver-pack' },
  });
  assert.deepEqual(store.low_stock.request({ max: 2 }), {
    path: 'stock',
    params: { max: 2, limit: undefined },
  });
  assert.deepEqual(store.low_stock.request({ max: -1, limit: 200 }), {
    path: 'stock',
    params: { max: -1, limit: 200 },
  });
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

test('admin_read reads one admin screen, its filters passed on', () => {
  const [read] = TOOLS.admin;
  assert.equal(read.name, 'admin_read');
  assert.deepEqual(
    read.request({
      path: '/admin/customers',
      params: { q: 'Ace', limit: 20 },
    }),
    {
      path: 'read',
      params: { q: 'Ace', limit: 20, path: '/admin/customers' },
    },
  );
  // A filter named path can never redirect the read.
  assert.equal(
    read.request({ path: '/admin/packs', params: { path: '/admin/users' } })
      .params.path,
    '/admin/packs',
  );
  assert.deepEqual(read.request({ path: '/admin/stats' }).params, {
    path: '/admin/stats',
  });
});

test('db_query posts one query to the sql route, with a minute to answer', async () => {
  const query = TOOLS.admin.find((t) => t.name === 'db_query');
  assert.deepEqual(query.request({ sql: 'SELECT 1' }), {
    path: 'sql',
    post: { sql: 'SELECT 1' },
    timeoutMs: 60_000,
  });
  let seen;
  const out = await runTool(
    ALL_TOOLS.find((t) => t.name === 'db_query'),
    { sql: 'SELECT 1' },
    {
      ...config,
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init };
        return new Response('{"rows":[{"n":1}]}');
      },
    },
  );
  assert.ok(!out.isError);
  assert.equal(seen.url, 'https://backend.test/reports/admin/sql');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { sql: 'SELECT 1' });
});

test('the code tools answer on this PC, without the backend', async () => {
  assert.deepEqual(
    TOOLS.code.map((t) => t.name),
    ['code_files', 'code_search', 'code_read'],
  );
  const local = {
    name: 'code_read',
    local: async (args) => `read ${args.path}`,
  };
  const out = await runTool(
    local,
    { path: 'CONTEXT.md' },
    {
      ...config,
      fetchImpl: async () => assert.fail('must not call the backend'),
    },
  );
  assert.deepEqual(out, {
    content: [{ type: 'text', text: 'read CONTEXT.md' }],
  });
  const failed = await runTool(
    {
      local: async () => {
        throw new Error('No file nope.ts on master.');
      },
    },
    {},
    config,
  );
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, 'No file nope.ts on master.');
});

test('every desk gets every tool once, each bound to its own desk', () => {
  assert.equal(ALL_TOOLS.length, 30);
  assert.equal(new Set(ALL_TOOLS.map((t) => t.name)).size, 30);
  for (const [desk, tools] of Object.entries(TOOLS)) {
    for (const tool of tools) {
      assert.equal(ALL_TOOLS.find((t) => t.name === tool.name).desk, desk);
    }
  }
});

test("runTool calls the tool's own desk, whichever desk asks", async () => {
  let url;
  const store = ALL_TOOLS.find((t) => t.name === 'packs');
  const out = await runTool(
    store,
    {},
    {
      ...config,
      desk: 'growth',
      fetchImpl: async (u) => {
        url = String(u);
        return new Response('{"packs":[]}');
      },
    },
  );
  assert.ok(!out.isError);
  assert.equal(url, 'https://backend.test/reports/store/packs');
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
  // Compact: Hermes spills MCP results over 50K chars to a file the bot
  // cannot read, and indentation alone can add a third.
  assert.doesNotMatch(ok.content[0].text, /\n/);
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
