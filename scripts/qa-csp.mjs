// Loads key routes against the running standalone storefront and fails if the
// browser reports ANY CSP violation. Run after `npm run build && serve :4000`.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const ROUTES = ['/', '/claw', '/leaderboard', '/how-it-works', '/about'];
const OUT_DIR = 'docs/research/csp';

const browser = await chromium.launch();
const page = await browser.newPage();
const violations = [];
page.on('console', (msg) => {
  const t = msg.text();
  if (/Content Security Policy|Refused to|CSP-VIOLATION/i.test(t))
    violations.push(t);
});
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (e) => {
    console.error(
      `CSP-VIOLATION ${e.effectiveDirective || e.violatedDirective} blocked ${e.blockedURI}`,
    );
  });
});

await mkdir(OUT_DIR, { recursive: true });

for (const route of ROUTES) {
  violations.length = 0;
  const startedAt = Date.now();
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const loadMs = Date.now() - startedAt;
  const routeId = route === '/' ? 'home' : route.slice(1).replaceAll('/', '_');
  await page.screenshot({ path: `${OUT_DIR}/${routeId}.png`, fullPage: true });
  await writeFile(
    `${OUT_DIR}/${routeId}.json`,
    JSON.stringify({ route, loadMs, violations }, null, 2),
  );
  if (violations.length) {
    console.error(`CSP violations on ${route}:`);
    violations.forEach((v) => console.error('  ' + v));
    await browser.close();
    process.exit(1);
  }
  console.log(`OK ${route}`);
}
await browser.close();
console.log('No CSP violations.');
