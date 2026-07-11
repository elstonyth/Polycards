import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM, simDatabaseUrl, simRedisUrl, runDir } from './config.mjs';

test('has 8 personas with unique ids and colors', () => {
  assert.equal(SIM.personas.length, 8);
  assert.equal(new Set(SIM.personas.map((p) => p.id)).size, 8);
  assert.ok(SIM.personas.every((p) => /^#[0-9a-f]{6}$/i.test(p.color)));
});

test('time-shift targets include the daily-draw text day', () => {
  const t = SIM.TIME_SHIFT_TARGETS.find(
    (x) => x.table === 'reward_draw' && x.column === 'draw_day',
  );
  assert.equal(t.kind, 'textday');
});

test('simDatabaseUrl swaps only the database name', () => {
  const out = simDatabaseUrl('postgres://u:p@localhost:5432/pokenic?ssl=false');
  assert.equal(out, 'postgres://u:p@localhost:5432/pixelslot_sim?ssl=false');
});

test('simRedisUrl swaps only the db index, preserving host + creds', () => {
  const out = simRedisUrl('redis://:secret@localhost:6379/0');
  assert.equal(out, 'redis://:secret@localhost:6379/9');
});

test('simRedisUrl falls back to the local container when .env has none', () => {
  assert.equal(simRedisUrl(undefined), 'redis://localhost:6379/9');
});

test('runDir is under scripts/sim/runs', () => {
  assert.match(runDir('r1').replaceAll('\\', '/'), /scripts\/sim\/runs\/r1$/);
});
