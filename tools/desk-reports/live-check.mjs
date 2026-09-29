// Post-deploy check (spec "Live"): for one window, every economy total for
// group=default plus each named group must equal group=all. Reads the Finance
// desk key from its Hermes profile and never prints it.
// Usage: node tools/desk-reports/live-check.mjs [period]   (default: today)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getReport } from './http.mjs';
import { resolvePeriod } from './periods.mjs';

const profileEnv = join(
  process.env.LOCALAPPDATA,
  'hermes',
  'profiles',
  'polycards-finance',
  '.env',
);
const key =
  /^REPORT_KEY_FINANCE=(.*)$/m
    .exec(readFileSync(profileEnv, 'utf8'))?.[1]
    ?.trim() ?? '';
const config = {
  baseUrl: process.env.REPORTS_BASE_URL || 'https://admin.polycards.gg',
  desk: 'finance',
  key,
};
const window = resolvePeriod(process.argv[2] ?? 'today');
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
const parts = [await totals('default')];
for (const g of groups) parts.push(await totals(g.name));
let ok = true;
for (const field of Object.keys(all)) {
  const sum = parts.reduce((s, t) => s + Math.round(t[field] * 100), 0) / 100;
  const match = sum === all[field];
  ok &&= match;
  console.log(
    `${match ? 'ok  ' : 'FAIL'} ${field}: all ${all[field]}, default + groups ${sum}`,
  );
}
console.log(
  `${window.label}; groups: default, ${groups.map((g) => g.name).join(', ')}`,
);
process.exit(ok ? 0 : 1);
