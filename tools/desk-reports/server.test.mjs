import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio round trip: every desk gets every read-only tool, the key on the wire, never in stderr', async () => {
  const seen = [];
  const backend = createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-report-key'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ currency: 'MYR', totals: { revenue: 12.5 } }));
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const key = 'k'.repeat(64);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
    env: {
      ...getDefaultEnvironment(),
      // Developer owns no reports, and still reads them all.
      REPORTS_DESK: 'developer',
      REPORTS_KEY: key,
      REPORTS_BASE_URL: `http://127.0.0.1:${backend.address().port}`,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: 'desk-reports-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        'economy',
        'daily_economy',
        'payments',
        'pack_sales',
        'player',
        'groups',
        'challenge',
        'signups',
        'packs_opened',
        'tasks',
        'top_pulls',
        'challenge_poster',
        'brand_poster',
        'achievements_poster',
        'top_pulls_poster',
        'brand_logo',
        'packs',
        'pack',
        'low_stock',
        'order',
        'account',
      ],
    );
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true);
    const result = await client.callTool({
      name: 'economy',
      arguments: { period: 'all_time', group: 'default' },
    });
    assert.ok(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).totals.revenue, 12.5);
    // Each tool calls its own desk's route, with this desk's one key.
    await client.callTool({ name: 'packs', arguments: {} });
    assert.deepEqual(seen, [
      { url: '/reports/finance/economy?group=default', key },
      { url: '/reports/store/packs', key },
    ]);
    assert.match(stderr, /key configured: yes \(64 chars\)/);
    assert.ok(!stderr.includes(key));
  } finally {
    await client.close();
    backend.close();
  }
});
