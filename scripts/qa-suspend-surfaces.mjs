// QA for the 2026-07-29 reward-surface suspension: /vip, /vouchers and /daily
// must 404; the home teaser must drop the referral pitch; (best-effort) a
// logged-in /me must carry no links into the dead routes.
// (/referrals and /invite/* left this sweep when the referral engine was
// removed outright — those paths are free for the rebuilt system to claim.)
// Run after `npm run build && pwsh scripts/serve-standalone.ps1 -Port 4110`.
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';

const BASE = process.env.PW_BASE ?? 'http://localhost:4110';
const OUT_DIR = 'docs/research';

/** Parse .env.local for backend URL + publishable key (never printed). */
async function loadEnv() {
  const env = {};
  try {
    const raw = await readFile('.env.local', 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  } catch {
    /* no .env.local — backend probes just get skipped */
  }
  return env;
}

const env = await loadEnv();
const BACKEND = env.NEXT_PUBLIC_MEDUSA_BACKEND_URL ?? 'http://localhost:9000';
const PUB_KEY = env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY;

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

await mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();

// 1. Suspended routes must 404.
for (const route of [
  '/vip',
  '/vouchers',
  '/daily',
]) {
  const resp = await page.goto(BASE + route, {
    waitUntil: 'load',
    timeout: 30_000,
  });
  check(resp?.status() === 404, `${route} returns 404 (got ${resp?.status()})`);
}

// 2. Home copy: referral teaser gone, VIP teaser stays.
await page.goto(BASE + '/', { waitUntil: 'load', timeout: 30_000 });
await page.waitForTimeout(1500); // let Reveal sections fire
const homeText = await page.evaluate(() => document.body.innerText);
check(
  !homeText.includes('TWO-TIER REFERRALS'),
  'home has no TWO-TIER REFERRALS copy',
);
check(
  homeText.includes('100 VIP LEVELS'),
  'home keeps the 100 VIP LEVELS teaser',
);
await page.screenshot({
  path: `${OUT_DIR}/qa-suspend-home.png`,
  fullPage: false,
});

// 3. Logged-out /me → bounced home (the AuthModal consumes ?auth=login and
//    strips it from the URL, so only the pathname is stable to assert).
await page.goto(BASE + '/me', { waitUntil: 'load', timeout: 30_000 });
check(
  new URL(page.url()).pathname === '/',
  `logged-out /me bounces home (got ${page.url()})`,
);
await page.screenshot({ path: `${OUT_DIR}/qa-suspend-me-loggedout.png` });

// 4. Best-effort logged-in /me via a throwaway customer against the running
//    backend (memory: register token has empty actor_id — mint the session
//    token AFTER /store/customers links it).
let loggedInChecked = false;
if (PUB_KEY) {
  try {
    const email = `qa-suspend-${Date.now()}@example.com`;
    const password = 'Throwaway123!';
    const j = async (res) => {
      if (!res.ok) throw new Error(`${res.url} -> ${res.status}`);
      return res.json();
    };
    const { token: regToken } = await j(
      await fetch(`${BACKEND}/auth/customer/emailpass/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }),
    );
    await j(
      await fetch(`${BACKEND}/store/customers`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${regToken}`,
          'x-publishable-api-key': PUB_KEY,
        },
        body: JSON.stringify({ email }),
      }),
    );
    const { token } = await j(
      await fetch(`${BACKEND}/auth/customer/emailpass`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }),
    );
    await context.addCookies([
      {
        name: '_polycards_jwt',
        value: token,
        url: BASE,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await page.goto(BASE + '/me', { waitUntil: 'load', timeout: 30_000 });
    check(
      new URL(page.url()).pathname === '/me',
      'logged-in /me renders (no bounce)',
    );
    // The page streams its server components — wait for a late section to land
    // before reading text, or the asserts run against the loading skeleton.
    await page
      .getByText('Quick access')
      .waitFor({ timeout: 20_000 })
      .catch(() => {});
    await page.waitForTimeout(1000);
    const meText = await page.evaluate(() => document.body.innerText);
    check(/LV \d+/.test(meText), '/me still shows the VIP level number');
    check(!meText.includes('Invite friends'), '/me has no Invite friends card');
    check(!meText.includes('Vouchers'), '/me has no Vouchers tile');
    // `Today.s` not `Today's`: the deleted markup was `Today&rsquo;s box`,
    // which renders with U+2019 — an ASCII-apostrophe check passed against the
    // UNMODIFIED page and proved nothing.
    check(!/Today.s box/.test(meText), "/me has no Today's box line");
    const deadLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.getAttribute('href'))
        // /rewards was a redirect stub into /vip, so it 404s too.
        .filter((h) =>
          /^\/(vip|vouchers|daily|rewards)(\/|$)/.test(h),
        ),
    );
    check(
      deadLinks.length === 0,
      `/me links into no dead route (found: ${deadLinks.join(', ') || 'none'})`,
    );
    await page.screenshot({
      path: `${OUT_DIR}/qa-suspend-me.png`,
      fullPage: true,
    });
    loggedInChecked = true;
  } catch (err) {
    console.warn(`WARN  logged-in /me check skipped: ${err.message}`);
  }
} else {
  console.warn(
    'WARN  no NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY in .env.local — logged-in /me skipped',
  );
}
if (!loggedInChecked) {
  console.warn(
    'WARN  MANUAL GAP: verify a logged-in /me shows the level card unlinked, no voucher/daily/invite blocks',
  );
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} assertion(s) FAILED`);
  process.exit(1);
}
// Exit 2, not 0, when the logged-in half never ran: six of the nine assertions
// live in that block, and a plain 0 would read as "verified" to anything
// automated. Green-but-incomplete is its own state.
if (!loggedInChecked) {
  console.warn('\nPASSED WITH SKIPS — logged-in /me not verified (exit 2)');
  process.exit(2);
}
console.log('\nAll assertions passed (incl. logged-in /me)');
