import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents } from './event-log.mjs';

function fresh() {
  return mkdtempSync(join(tmpdir(), 'sim-ev-'));
}

test('append then read round-trips and assigns increasing seq', () => {
  const dir = fresh();
  appendEvent(dir, { day: 1, actor: 'honest', kind: 'arrived' });
  appendEvent(dir, {
    day: 1,
    actor: 'honest',
    kind: 'played_pack',
    detail: { slot: 'slot1' },
  });
  const evs = readEvents(dir);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].seq, 0);
  assert.equal(evs[1].seq, 1);
  assert.equal(evs[1].detail.slot, 'slot1');
});

test('readEvents returns [] when the log does not exist yet', () => {
  assert.deepEqual(readEvents(fresh()), []);
});

test('readEvents skips a torn/garbage line and keeps the good record', () => {
  const dir = fresh();
  appendEvent(dir, { day: 1, actor: 'honest', kind: 'arrived' });
  appendFileSync(join(dir, 'events.jsonl'), '{"day":2,"actor":"honest"' + '\n');
  const evs = readEvents(dir);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'arrived');
});

test('concurrent appends do not interleave within a line', () => {
  const dir = fresh();
  for (let i = 0; i < 50; i++)
    appendEvent(dir, { day: 1, actor: 'x', kind: 'arrived' });
  const evs = readEvents(dir);
  assert.equal(evs.length, 50);
  assert.deepEqual(
    evs.map((e) => e.seq),
    [...Array(50).keys()],
  );
});
