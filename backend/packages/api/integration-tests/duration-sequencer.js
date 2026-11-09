// Splits `--shard=N/M` by recorded duration instead of jest's default path
// hash. Hash shards on the first 10-shard CI run spread 181-347s of tests
// (mean 254s); the slowest shard sets the wall time, so the split is what
// matters. Greedy longest-first: each file goes to the lightest shard so far.
//
// Every shard job lists the same files from the same commit and sorts them
// the same way, so they all compute the same split and each takes its own
// slice. A file missing from test-timings.json (new or renamed) is placed at
// the median, so stale timings cost balance, never coverage. Refresh with
// `node integration-tests/refresh-test-timings.mjs <ci run id>`.
const path = require('node:path');
const Sequencer = require('@jest/test-sequencer').default;
const timings = require('./test-timings.json');

/** @returns {Map<string, number>} file key -> 0-based shard index */
function assignShards(keys, durations, shardCount) {
  const known = keys
    .map((k) => durations[k])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  const items = keys
    .map((k) => ({
      k,
      s: Number.isFinite(durations[k]) ? durations[k] : fallback,
    }))
    .sort((a, b) => b.s - a.s || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const load = Array(shardCount).fill(0);
  const shardOf = new Map();
  for (const { k, s } of items) {
    let lightest = 0;
    for (let i = 1; i < shardCount; i++)
      if (load[i] < load[lightest]) lightest = i;
    load[lightest] += s;
    shardOf.set(k, lightest);
  }
  return shardOf;
}

class DurationSequencer extends Sequencer {
  shard(tests, { shardIndex, shardCount }) {
    const key = (t) =>
      path.relative(t.context.config.rootDir, t.path).split(path.sep).join('/');
    const shardOf = assignShards(tests.map(key), timings, shardCount);
    return tests.filter((t) => shardOf.get(key(t)) === shardIndex - 1);
  }
}

module.exports = DurationSequencer;
module.exports.assignShards = assignShards;
