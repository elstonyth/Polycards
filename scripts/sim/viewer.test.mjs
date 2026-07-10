import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent } from './event-log.mjs';
import { startViewer } from './viewer.mjs';

test('GET / serves the canvas page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-vw-'));
  const v = startViewer({ dir, port: 0 });
  try {
    const res = await fetch(v.url + '/');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<canvas/i);
  } finally {
    v.close();
  }
});

test('SSE stream replays an existing event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-vw-'));
  appendEvent(dir, { day: 1, actor: 'honest', kind: 'arrived' });
  const v = startViewer({ dir, port: 0 });
  try {
    const res = await fetch(v.url + '/events');
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /"kind":"arrived"/);
    await reader.cancel();
  } finally {
    v.close();
  }
});
