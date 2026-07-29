#!/usr/bin/env node
// Runs the HTTP integration gate in sequential jest SHARDS.
//
// Why: every suite boots a full Medusa app via medusaIntegrationTestRunner and
// memory accumulates across suites in a single --runInBand process. At 66
// suites the run exhausts node's default ~4GB old-space ("Ineffective
// mark-compacts near heap limit") and dies without a jest summary — even 8GB
// only reached 62/66. Splitting into shards resets the heap per process while
// keeping --runInBand semantics inside each shard (suites still create their
// own DBs and run serially).
//
// Usage (via package.json):
//   corepack yarn test:integration:http                 -> all suites, SHARDS sequential shards
//   corepack yarn test:integration:http economy.spec …  -> filtered single run (no sharding)
//
// Redis: the rate-limit and password-reset suites probe a real redis
// (TEST_REDIS_URL in http/utils.ts — REDIS_URL or redis://localhost:6379;
// `docker start pokenic-redis`). Only the Medusa redis MODULES are forced
// in-memory under TEST_TYPE (medusa-config), not those suites' probes.
import { spawnSync } from 'node:child_process';

// 8 shards ≈ 11 suites/process at the current 88 suites — matches CI's
// integration-http matrix (ci.yml passes --shard=N/8 explicitly; keep the two
// in sync). Even at ~11 suites a shard's cumulative heap can clear node's
// default old-space, so CI's heap bump is mirrored into NODE_OPTIONS below.
const SHARDS = 8;

const jestArgs = ['--silent=false', '--runInBand', '--forceExit'];
const env = {
  ...process.env,
  TEST_TYPE: 'integration:http',
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS,
    '--experimental-vm-modules',
    // CI exports its own; default it here so a plain local
    // `corepack yarn test:integration:http` clears the heap too. The regex
    // also matches node's underscore alias (--max_old_space_size) so a
    // caller's cap is never silently overridden by last-flag-wins.
    /--max[-_]old[-_]space[-_]size/.test(process.env.NODE_OPTIONS ?? '')
      ? null
      : '--max-old-space-size=6144',
  ]
    .filter(Boolean)
    .join(' '),
};

const runJest = (extra) =>
  spawnSync(
    process.execPath,
    ['node_modules/jest/bin/jest.js', ...jestArgs, ...extra],
    { stdio: 'inherit', env },
  ).status ?? 1;

const patterns = process.argv.slice(2);
if (patterns.length > 0) {
  // A filtered run is small — no sharding, behaves like the old script.
  process.exit(runJest(patterns));
}

let failed = 0;
for (let i = 1; i <= SHARDS; i++) {
  console.log(`\n=== HTTP gate shard ${i}/${SHARDS} ===`);
  const status = runJest([`--shard=${i}/${SHARDS}`]);
  if (status !== 0) failed = status;
}
console.log(
  failed === 0
    ? `\nHTTP gate: all ${SHARDS} shards green.`
    : `\nHTTP gate: shard failure (exit ${failed}) — see summaries above.`,
);
process.exit(failed);
