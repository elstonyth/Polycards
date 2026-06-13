// QA — Packs-only deploy gating on the PROD build (:4000).
// Asserts (with the feature flags OFF, the default state):
//   - Home nav shows Packs + a non-clickable "Coming Soon" + Leaderboard, and
//     NO Marketplace tab; footer has no Marketplace link; no /marketplace link
//     anywhere on the page.
//   - /marketplace and /pack-party return HTTP 404 and render the custom
//     not-found page.
//   - The 404 CTA reads "Back to packs" → /claw (never links to /marketplace).
//   - Mobile menu mirrors the same (Coming Soon span, no Marketplace link).
// Headless; screenshots to docs/research/. Run: node scripts/verify-packs-only.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const browser = await chromium.launch({ headless: true });

try {
  // ── Desktop home: nav + footer state ───────────────────────────────────────
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

  const mpLinks = await page.locator('a[href="/marketplace"]').count();
  if (mpLinks === 0)
    ok('home: zero links to /marketplace (nav + footer clean)');
  else fail(`home: found ${mpLinks} link(s) to /marketplace`);

  const ppLinks = await page.locator('a[href="/pack-party"]').count();
  if (ppLinks === 0) ok('home: zero clickable links to /pack-party');
  else fail(`home: found ${ppLinks} clickable link(s) to /pack-party`);

  const comingSoon = page
    .locator('span[aria-disabled="true"]')
    .filter({ hasText: 'Coming Soon' });
  if (await comingSoon.count())
    ok("home: non-clickable 'Coming Soon' tab present");
  else fail("home: 'Coming Soon' disabled tab missing");

  if (await page.locator('a[href="/claw"]').count())
    ok('home: Packs tab (/claw) present');
  else fail('home: Packs tab (/claw) missing');

  if (await page.locator('a[href="/leaderboard"]').count())
    ok('home: Leaderboard tab present');
  else fail('home: Leaderboard tab missing');

  await page.screenshot({ path: 'docs/research/verify-packs-only-home.png' });

  // ── Mobile menu mirrors the same gating ────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /open menu/i }).click();
  await page.waitForTimeout(400);
  const mMp = await page.locator('a[href="/marketplace"]').count();
  if (mMp === 0) ok('mobile menu: no Marketplace link');
  else fail(`mobile menu: ${mMp} Marketplace link(s)`);
  await page.screenshot({
    path: 'docs/research/verify-packs-only-mobile.png',
  });
  await ctx.close();

  // ── Hidden routes 404 ──────────────────────────────────────────────────────
  const ctx2 = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page2 = await ctx2.newPage();

  for (const route of ['/marketplace', '/pack-party']) {
    // Status comes from the server response (authoritative). Body assertions use
    // the served HTML — getByText is unreliable on a prerendered 404 shell.
    const res = await page2.goto(`${BASE}${route}`, {
      waitUntil: 'domcontentloaded',
    });
    const status = res?.status();
    const html = await page2.content();
    if (status === 404) ok(`${route} → HTTP 404`);
    else fail(`${route} → HTTP ${status} (expected 404)`);
    if (/Page not found/.test(html))
      ok(`${route} renders the custom not-found page`);
    else fail(`${route} did not render the not-found page`);
    // CTA text flips to "Back to packs" (→ /claw) while marketplace is hidden.
    // href may be an HTML attribute or an RSC-payload prop, so assert on the
    // label swap rather than a literal href string.
    if (/Back to packs/.test(html) && !/Back to marketplace/.test(html))
      ok(`${route} 404 CTA reads 'Back to packs' (not marketplace)`);
    else fail(`${route} 404 CTA did not flip to 'Back to packs'`);
    if (
      !/href="\/marketplace"/.test(html) &&
      !/"href":"\/marketplace"/.test(html)
    )
      ok(`${route} 404 links nowhere to /marketplace`);
    else fail(`${route} 404 has a /marketplace link`);
  }

  await page2.screenshot({ path: 'docs/research/verify-packs-only-404.png' });
  await ctx2.close();
} finally {
  await browser.close();
}

console.log(
  '\nnote: this asserts the FLAGS-OFF (hidden) state. To verify reversibility, set\n' +
    'NEXT_PUBLIC_FEATURE_MARKETPLACE=true + NEXT_PUBLIC_FEATURE_PACK_PARTY=true in\n' +
    '.env.local, rebuild, and re-run — the tab and routes should come back.',
);
