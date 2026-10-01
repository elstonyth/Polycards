// Post-deploy check (spec "Live"): for one window, every economy total for
// group=default plus each named group must equal group=all (checkPartition
// also refuses a window with no activity, which would pass vacuously). Reads
// the Finance desk key from its Hermes profile and never prints it.
// Usage: node tools/desk-reports/live-check.mjs [period]   (default: last_7_days)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getReport } from './http.mjs';
import { checkPartition } from './partition.mjs';
import { resolvePeriod } from './periods.mjs';

const profileEnv = join(
  process.env.LOCALAPPDATA,
  'hermes',
  'profiles',
  'polycards-finance',
  '.env',
);
const key = (
  /^REPORT_KEY_FINANCE=(.*)$/m.exec(readFileSync(profileEnv, 'utf8'))?.[1] ?? ''
)
  .trim()
  .replace(/^['"]|['"]$/g, '');
const config = {
  baseUrl: process.env.REPORTS_BASE_URL || 'https://admin.polycards.gg',
  desk: 'finance',
  key,
};
// A rolling window ends when the script starts, so a ledger write during the
// run cannot land in one request and miss the next (today ends at midnight).
const window = resolvePeriod(process.argv[2] ?? 'last_7_days');
const totals = async (group) =>
  (
    await getReport({
      ...config,
      path: 'economy',
      params: { from: window.from, to: window.to, group },
    })
  ).totals;

const { groups } = await getReport({ ...config, path: 'groups' });
const all = await totals('all');
const parts = [['default', await totals('default')]];
for (const g of groups) parts.push([g.name, await totals(g.name)]);
const { ok, lines, warnings } = checkPartition(all, parts);
console.log(window.label);
console.log(`groups: ${parts.map(([name]) => name).join(', ')}`);
for (const line of lines) console.log(line);
for (const warning of warnings) console.log(`warning: ${warning}`);
process.exit(ok ? 0 : 1);
