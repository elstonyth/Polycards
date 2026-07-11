import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetFor } from './choreography.mjs';
import { SIM } from './config.mjs';

test('playing a pack sends the sprite to the named slot', () => {
  const t = targetFor({ kind: 'played_pack', detail: { slot: 'slot3' } });
  assert.deepEqual({ x: t.x, y: t.y }, SIM.stations.slot3);
  assert.equal(t.mood, 'busy');
});

test('complaining marches the sprite to the desk, angry', () => {
  const t = targetFor({ kind: 'complained' });
  assert.deepEqual({ x: t.x, y: t.y }, SIM.stations.desk);
  assert.equal(t.mood, 'angry');
});

test('a legendary pull is happy', () => {
  assert.equal(
    targetFor({ kind: 'pull_result', detail: { rarity: 'legendary' } }).mood,
    'happy',
  );
});

test('unknown kind falls back to entrance without throwing', () => {
  const t = targetFor({ kind: 'not-a-real-kind' });
  assert.deepEqual({ x: t.x, y: t.y }, SIM.stations.entrance);
  assert.equal(t.mood, 'neutral');
});
