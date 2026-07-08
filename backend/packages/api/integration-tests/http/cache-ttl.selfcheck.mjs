// Standalone self-check for the per-process TTL cache branch shared by the
// leaderboard (boardCache), pack-detail (packCache), recent-pulls
// (recentCache) and pack-list (listCache) store routes. The routes themselves
// can only run under the medusa integration runner (needs Postgres); this
// pins the pure cache branch — `cached && cached.expires > Date.now()` +
// populate-after-compute — that is copied verbatim into all four handlers.
//
// Run: node integration-tests/http/cache-ttl.selfcheck.mjs
import assert from 'node:assert/strict';

// Exact shape used in the routes: Map<key, { expires, body }>, TTL check at the
// top of the handler, set after compute.
function makeCache(ttlMs) {
  const cache = new Map();
  let computes = 0;
  const get = (key, compute, now = Date.now()) => {
    const cached = cache.get(key);
    if (cached && cached.expires > now) return cached.body; // HIT: no compute
    computes += 1;
    const body = compute();
    cache.set(key, { expires: now + ttlMs, body });
    return body;
  };
  return { get, clear: () => cache.clear(), computes: () => computes };
}

// 1) Cold call computes; a second call within the TTL window is served cached.
const c = makeCache(30_000);
const t0 = 1_000_000;
assert.equal(c.get('a', () => 'A', t0), 'A');
assert.equal(c.get('a', () => 'A2', t0 + 5_000), 'A'); // within TTL → stale hit
assert.equal(c.computes(), 1, 'N cold calls collapse to 1 within the window');

// 2) After expiry it recomputes (fresh body wins).
assert.equal(c.get('a', () => 'A3', t0 + 30_001), 'A3');
assert.equal(c.computes(), 2, 'recompute once the entry has expired');

// 3) Keyed by argument: a different key is an independent entry (slug isolation).
assert.equal(c.get('b', () => 'B', t0 + 30_001), 'B');
assert.equal(c.computes(), 3);

// 4) clear() drops everything (the test seam clearPackDetailCache/…).
c.clear();
assert.equal(c.get('a', () => 'A4', t0 + 30_002), 'A4');
assert.equal(c.computes(), 4, 'clear() forces a fresh compute');

// 5) Fail-open guarantee: the routes never let a cache error mask compute —
//    a thrown compute must propagate, not get swallowed into a stale/empty body.
assert.throws(() => c.get('err', () => { throw new Error('boom'); }, t0));
//    …and the failed compute must not poison the cache: a later successful
//    compute for the same key still runs and caches normally.
assert.equal(c.get('err', () => 'OK', t0 + 1), 'OK');
assert.equal(c.computes(), 6, 'a failed compute does not block a later successful one');

// 6) Default now = Date.now(): two back-to-back calls (no explicit now) land in
//    the same TTL window → second is served cached, exercising the default path.
const beforeZ = c.computes();
assert.equal(c.get('z', () => 'Z'), 'Z');
assert.equal(c.get('z', () => 'Z2'), 'Z'); // real-clock ms apart, well within 30s
assert.equal(c.computes(), beforeZ + 1, 'default Date.now() path: one compute per window');

console.log('cache-ttl.selfcheck: OK');
