import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getReport, ReportError } from './http.mjs';

const KEY = 'k'.repeat(64);
const base = { baseUrl: 'https://backend.test', desk: 'finance', key: KEY };
const reply = (status, body) => async () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('sends the key header and only the params that are set', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), init };
    return new Response('{"ok":true}', { status: 200 });
  };
  const body = await getReport({
    ...base,
    path: 'economy',
    params: {
      from: '2026-09-28T16:00:00.000Z',
      to: null,
      group: 'default',
      extra: undefined,
      empty: '',
    },
    fetchImpl,
  });
  assert.deepEqual(body, { ok: true });
  assert.equal(
    seen.url,
    'https://backend.test/reports/finance/economy?from=2026-09-28T16%3A00%3A00.000Z&group=default',
  );
  assert.equal(seen.init.headers['x-report-key'], KEY);
});

test('refuses to call without a real key', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
  };
  for (const key of ['', '${REPORT_KEY_FINANCE}']) {
    await assert.rejects(
      getReport({ ...base, key, path: 'economy', fetchImpl }),
      /not configured/,
    );
  }
  assert.equal(called, false);
});

test('turns every failure into a sentence without the key in it', async () => {
  const cases = [
    [
      reply(400, { message: 'Unknown player group "X".' }),
      /Unknown player group/,
    ],
    [reply(404, { message: 'No player with username bob.' }), /No player/],
    [reply(401, { message: 'Unauthorized' }), /not set up/],
    [
      reply(503, { message: 'Reports are not configured for this desk.' }),
      /not set up/,
    ],
    [reply(429, {}), /Too many/],
    [reply(500, {}), /failed \(500\)/],
    // A 2xx with no JSON object body is a failure, not a blank report.
    [
      async () => new Response('<html>oops</html>', { status: 200 }),
      /unreadable/,
    ],
    [async () => new Response('', { status: 200 }), /unreadable/],
    [
      async () => {
        throw new TypeError('fetch failed');
      },
      /Could not reach/,
    ],
  ];
  for (const [fetchImpl, message] of cases) {
    const err = await getReport({ ...base, path: 'economy', fetchImpl }).catch(
      (e) => e,
    );
    assert.ok(err instanceof ReportError);
    assert.match(err.message, message);
    assert.ok(!err.message.includes(KEY));
  }
});
