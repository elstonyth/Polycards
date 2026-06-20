// axe-core accessibility scan of key public routes against the running
// standalone storefront (:4000). Fails on serious/critical violations.
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const ROUTES = ['/', '/claw', '/leaderboard', '/how-it-works', '/about'];

const browser = await chromium.launch();
const page = await browser.newPage();
let failed = false;

for (const route of ROUTES) {
  // 'load' (not 'networkidle') so always-animating routes like /claw can't hang
  // the scan; a bounded timeout turns a stuck navigation into a loud failure
  // instead of an indefinite wait.
  let resp;
  try {
    resp = await page.goto(BASE + route, {
      waitUntil: 'load',
      timeout: 30_000,
    });
  } catch (err) {
    failed = true;
    console.error(`\n${route} — navigation failed: ${err.message}`);
    continue;
  }
  // A 404/500 would otherwise let axe scan the (clean) error page and pass.
  if (!resp || !resp.ok()) {
    failed = true;
    console.error(
      `\n${route} — bad response: ${resp ? resp.status() : 'none'}`,
    );
    continue;
  }
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const serious = violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  if (serious.length) {
    failed = true;
    console.error(`\n${route} — ${serious.length} serious/critical:`);
    for (const v of serious)
      console.error(`  [${v.impact}] ${v.id}: ${v.help}`);
  } else {
    console.log(`OK ${route}`);
  }
}
await browser.close();
if (failed) process.exit(1);
console.log('\nNo serious/critical a11y violations.');
