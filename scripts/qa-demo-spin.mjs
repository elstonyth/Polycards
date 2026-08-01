// Guest demo-spin behavior on the PROD build (:4000) — the demo/real boundary.
// (Reel physics live in qa-press-spin.mjs; the real paid loop in
// qa-spin-conclude.mjs. This file owns the MODE assertions.)
//
// Flow A (anonymous, /slots/<pack>/spin?demo=1):
//   - machine renders in demo mode: "Demo" badge, 'Demo spin' CTA, and the
//     honesty footer ("Free demo — no credits charged, no real cards won")
//   - the demo spin plays through to the reveal, which offers the sign-up
//     conversion CTA + "Back to the reel" — and NO sell-back (nothing was won)
//   - ZERO POSTs during the whole flow: a demo draw is client-side theater and
//     must never hit the backend (the auth session check is a GET)
//   - the sign-up CTA opens the auth modal in signup mode
//   - without ?demo=1 the anonymous machine gates instead: 'Log in to spin'
// Flow B (logged-in customer on ?demo=1): demo is a pre-signup taste only —
//   a customer gets the REAL machine (no Demo badge, no demo footer, 'Spin'
//   CTA with the Bet line). No spin is fired (that's qa-spin-conclude's job).
//
// Run (stack up, standalone storefront on :4000):
//   node scripts/qa-demo-spin.mjs            # QA_PACK overrides the pack slug
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.STORE_BASE ?? 'http://127.0.0.1:4000';
const API = process.env.MEDUSA_BACKEND_URL ?? 'http://localhost:9000';
const PACK = process.env.QA_PACK ?? 'bronze-pack';

let failed = false;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  console.error(`✗ ${m}`);
  failed = true;
};

const browser = await chromium.launch({ headless: true });
try {
  // ── Flow A: anonymous visitor ─────────────────────────────────────────────
  const ctxA = await browser.newContext({
    viewport: { width: 1440, height: 860 },
    reducedMotion: 'no-preference',
  });
  const page = await ctxA.newPage();
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST') posts.push(r.url());
  });

  await page.goto(`${BASE}/slots/${PACK}/spin?demo=1`, {
    waitUntil: 'domcontentloaded',
  });
  // waitFor, not isVisible — the mode hydrates client-side from auth state.
  const spinCta = page.getByRole('button', { name: /^demo spin$/i });
  await spinCta.waitFor({ timeout: 20000 });
  ok("anonymous ?demo=1 machine shows the 'Demo spin' CTA");

  if (await page.getByText('Demo', { exact: true }).first().isVisible())
    ok('Demo badge shown on the machine');
  else fail('Demo badge missing');
  if (await page.getByText(/free demo — no credits charged/i).count())
    ok('honesty footer present (no credits charged, no real cards won)');
  else fail('demo honesty footer missing');

  // Cookie banner overlays the bottom controls — clear it before spinning.
  await page
    .getByRole('button', { name: /^(Accept|Reject)$/ })
    .first()
    .click({ timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(1500); // sprites paint, idle drift settles
  await spinCta.click();
  // The reveal has landed when a card back is tappable; tapping flips it and
  // surfaces the per-card footer (sign-up CTA on demo).
  await page.getByText('Tap the card to reveal').waitFor({ timeout: 60000 });
  await page.mouse.click(720, 380);
  const signup = page.getByRole('button', {
    name: /sign up & pull for real/i,
  });
  await signup.waitFor({ timeout: 15000 });
  ok('demo spin played through to the reveal with the sign-up CTA');

  if (await page.getByRole('button', { name: /back to the reel/i }).count())
    ok("demo reveal offers 'Back to the reel'");
  else fail("'Back to the reel' missing on the demo reveal");
  if (await page.getByRole('button', { name: /sell back/i }).count())
    fail('sell-back offered on a demo reveal (nothing was won)');
  else ok('no sell window on the demo reveal');

  // openPack is a Next SERVER ACTION: a real open would be a same-origin POST
  // (next-action header). The anon demo page makes no legitimate POST at all,
  // so the honest assertion is ZERO POSTs of any kind.
  if (posts.length === 0) ok('zero POSTs during the anonymous demo flow');
  else fail(`demo flow fired POST(s): ${posts.join(', ')}`);

  await signup.click();
  await page
    .getByRole('dialog', { name: /create account/i })
    .waitFor({ timeout: 10000 });
  ok('sign-up CTA opens the auth modal in signup mode');
  await page.screenshot({ path: 'docs/research/qa-demo-spin-anon.png' });

  // Anonymous WITHOUT ?demo=1: the machine gates on login instead.
  await page.goto(`${BASE}/slots/${PACK}/spin`, {
    waitUntil: 'domcontentloaded',
  });
  await page
    .getByRole('button', { name: /log in to spin/i })
    .waitFor({ timeout: 20000 });
  ok("anonymous real machine gates with 'Log in to spin'");
  await ctxA.close();

  // ── Flow B: logged-in customer on ?demo=1 gets the REAL machine ──────────
  const creds = Object.fromEntries(
    fs
      .readFileSync(path.join(process.cwd(), 'scripts/.dev-logins'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  if (!creds.CUST_PW) {
    console.log('SKIP flow B: no CUST_PW in scripts/.dev-logins');
  } else {
    const auth = await fetch(`${API}/auth/customer/emailpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: creds.CUST_EMAIL ?? 'test@polycards.app',
        password: creds.CUST_PW,
      }),
    }).then((r) => r.json());
    if (!auth.token) throw new Error('customer auth failed (flow B)');

    const ctxB = await browser.newContext({
      viewport: { width: 1440, height: 860 },
    });
    await ctxB.addCookies([
      {
        name: '_polycards_jwt',
        value: auth.token,
        url: BASE,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const page2 = await ctxB.newPage();
    await page2.goto(`${BASE}/slots/${PACK}/spin?demo=1`, {
      waitUntil: 'domcontentloaded',
    });
    await page2
      .getByRole('button', { name: /^spin$/i })
      .waitFor({ timeout: 20000 });
    ok("logged-in on ?demo=1 gets the real machine ('Spin' CTA)");
    if (await page2.getByText(/free demo — no credits charged/i).count())
      fail('demo honesty footer shown to a logged-in customer');
    else ok('no demo footer for the logged-in customer');
    if (await page2.getByText(/^Bet\b/).count())
      ok('real Bet line renders for the logged-in customer');
    else fail('Bet line missing for the logged-in customer');
    await page2.screenshot({ path: 'docs/research/qa-demo-spin-authed.png' });
    await ctxB.close();
  }
} catch (err) {
  fail(err.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
