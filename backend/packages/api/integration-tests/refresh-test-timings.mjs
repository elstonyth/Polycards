#!/usr/bin/env node
// Rewrites test-timings.json (read by duration-sequencer.js) from a green CI
// run's logs. Usage, from backend/packages/api:
//   node integration-tests/refresh-test-timings.mjs <ci.yml run id>
//
// Each shard runs --runInBand, so the gap between consecutive PASS/FAIL
// timestamps in one job is that file's wall cost (app boot + transform +
// tests). jest's own "(N s)" is printed only past its 5s slow threshold, so
// it is used only for a job's first file, which has no predecessor.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const runId = process.argv[2];
if (!/^\d+$/.test(runId ?? '')) {
  console.error('usage: refresh-test-timings.mjs <ci run id>');
  process.exit(1);
}
const log = execFileSync('gh', ['run', 'view', runId, '--log'], {
  encoding: 'utf8',
  maxBuffer: 1024 ** 3,
});
const line =
  /^(integration-http \(\d+\)|backend-unit \(\d+\))\t[^\t]*\t(\S+) (?:PASS|FAIL) +((?:integration-tests|src)\/\S+)(?: \(([\d.]+) (m?s)\))?/;

const byJob = new Map();
for (const row of log.split('\n')) {
  const m = line.exec(row);
  if (!m) continue;
  const [, job, ts, file, n, unit] = m;
  const own = n ? Number(n) / (unit === 'ms' ? 1000 : 1) : null;
  if (!byJob.has(job)) byJob.set(job, []);
  byJob.get(job).push({ t: Date.parse(ts), file, own });
}
if (byJob.size === 0) {
  console.error(
    `no backend-unit / integration-http PASS lines in run ${runId}`,
  );
  process.exit(1);
}

const out = {};
for (const rows of byJob.values()) {
  rows.sort((a, b) => a.t - b.t);
  rows.forEach((r, i) => {
    const s = i === 0 ? r.own : (r.t - rows[i - 1].t) / 1000;
    if (s != null) out[r.file] = Math.max(0.1, Math.round(s * 10) / 10);
  });
}
const sorted = Object.fromEntries(
  Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)),
);
const file = new URL('./test-timings.json', import.meta.url);
writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n');
console.log(`wrote ${Object.keys(sorted).length} timings from run ${runId}`);
