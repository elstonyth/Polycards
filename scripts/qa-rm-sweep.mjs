// scripts/qa-rm-sweep.mjs — greps rendered DOM for any '$' followed by a digit.
// Usage: node scripts/qa-rm-sweep.mjs (requires :4000 to be running)
import { chromium } from 'playwright';

const PAGES = [
  '/',
  '/marketplace',
  '/claw',
  '/leaderboard',
  '/repacks',
];
const b = await chromium.launch();
const p = await b.newPage();
const offenders = [];
const navErrors = [];
for (const path of PAGES) {
  try {
    await p.goto(`http://localhost:4000${path}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    const dollars = await p.$$eval('body *:not(script):not(style)', (els) =>
      els
        .filter(
          (e) => e.children.length === 0 && /\$\s?\d/.test(e.textContent || ''),
        )
        .map((e) => e.textContent.trim())
        .slice(0, 20),
    );
    if (dollars.length) offenders.push({ path, dollars });
  } catch {
    navErrors.push(path);
  }
}
await b.close();
console.log(JSON.stringify(offenders, null, 2));
if (navErrors.length) {
  console.error(
    `Navigation failed for ${navErrors.length} page(s): ${navErrors.join(', ')}`,
  );
  process.exit(1);
}
if (offenders.length) process.exit(1);
