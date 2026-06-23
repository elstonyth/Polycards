// Loads key routes against the running standalone storefront and fails if the
// browser reports ANY CSP violation. Run after `npm run build && serve :4000`.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const ROUTES = ['/', '/claw', '/leaderboard', '/how-it-works', '/about'];
const OUT_DIR = 'docs/research/csp';

const browser = await chromium.launch();
const page = await browser.newPage();

/** Print the lines, close the browser, and exit non-zero. */
const fail = async (...lines) => {
  console.error(lines.join('\n'));
  await browser.close();
  process.exit(1);
};

const violations = [];
page.on('console', (msg) => {
  const t = msg.text();
  // Benign report-only-mode notice, NOT a violation: the browser logs this
  // whenever `upgrade-insecure-requests` appears in a *report-only* policy (the
  // directive is only meaningful in enforcing mode). Nothing is blocked, and it
  // disappears once CSP_ENFORCE flips the header to enforcing — so don't fail on
  // it, or the gate can never pass while we verify in report-only mode.
  if (/upgrade-insecure-requests.*ignored.*report-only/i.test(t)) return;
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
  // 'load' (not 'networkidle') + a bounded timeout: always-animating routes like
  // /claw never go network-idle, so networkidle would hit the default timeout and
  // throw mid-scan. A 2s settle after load lets deferred scripts/styles fire so
  // late CSP violations still surface via the console + securitypolicyviolation
  // listeners below.
  let resp;
  try {
    resp = await page.goto(BASE + route, {
      waitUntil: 'load',
      timeout: 30_000,
    });
  } catch (err) {
    await fail(`${route} — navigation failed: ${err.message}`);
  }
  // A 404/500 would otherwise let the scan pass on a (CSP-clean) error page.
  if (!resp || !resp.ok()) {
    await fail(`${route} — bad response: ${resp ? resp.status() : 'none'}`);
  }
  await page.waitForTimeout(2000);
  const loadMs = Date.now() - startedAt;
  const routeId = route === '/' ? 'home' : route.slice(1).replaceAll('/', '_');
  await page.screenshot({ path: `${OUT_DIR}/${routeId}.png`, fullPage: true });
  await writeFile(
    `${OUT_DIR}/${routeId}.json`,
    JSON.stringify({ route, loadMs, violations }, null, 2),
  );
  if (violations.length) {
    await fail(
      `CSP violations on ${route}:`,
      ...violations.map((v) => '  ' + v),
    );
  }
  console.log(`OK ${route}`);
}
await browser.close();
console.log('No CSP violations.');
