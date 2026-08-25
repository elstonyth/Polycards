// Full storefront route sweep against the :4000 production standalone build.
// Visits EVERY route in src/app (logged out + logged in), recording document
// status, page JS exceptions, console errors, and 5xx network responses.
// Screenshots land in docs/research/sweep/.
//
//   QA_ADMIN_EMAIL=… QA_ADMIN_PASSWORD=… QA_CUSTOMER_EMAIL=… QA_CUSTOMER_PASSWORD=… \
//   node scripts/qa-full-route-sweep.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const FRONT = 'http://localhost:4000';
const API = 'http://localhost:9000';
const CUST = {
  email: process.env.QA_CUSTOMER_EMAIL ?? 'test@polycards.app',
  password: process.env.QA_CUSTOMER_PASSWORD,
};
mkdirSync('docs/research/sweep', { recursive: true });

async function call(url, init) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    return res;
  }
}

// --- auth: admin (for publishable key) + customer token ---
const adm = await call(`${API}/auth/user/emailpass`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: process.env.QA_ADMIN_EMAIL,
    password: process.env.QA_ADMIN_PASSWORD,
  }),
}).then((r) => r.json());
if (!adm.token) throw new Error('admin auth failed');
const keys = await call(`${API}/admin/api-keys?type=publishable`, {
  headers: { Authorization: `Bearer ${adm.token}` },
}).then((r) => r.json());
const PUB = keys.api_keys?.[0]?.token;
if (!PUB) throw new Error('no publishable key');

const cust = await call(`${API}/auth/customer/emailpass`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(CUST),
}).then((r) => r.json());
if (!cust.token) throw new Error('customer auth failed');

// --- derive dynamic params from store APIs ---
const SH = { 'x-publishable-api-key': PUB };
const packs = await call(`${API}/store/packs`, { headers: SH }).then((r) =>
  r.json(),
);
const slug =
  packs.packs?.[0]?.slug ?? packs.packs?.[0]?.handle ?? packs?.[0]?.slug;
console.log(`derived: pack slug=${slug}`);

const PUBLIC = [
  '/',
  '/about',
  '/auth/google/failed',
  '/contact',
  '/download',
  '/fairness',
  '/how-it-works',
  '/leaderboard',
  '/reset-password',
  '/slots',
  '/task',
  '/bank-withdrawal',
  ...(slug ? [`/slots/${slug}`, `/slots/${slug}/spin`] : []),
];
// /rewards and /vip removed with the 2026-07-29 suspension (#294); the
// referral routes went with the engine removal.
const ACCOUNT = [
  '/me',
  '/wallet',
  '/vault',
  '/orders',
  '/settings',
  '/transactions',
  '/notifications',
  '/addresses',
];

let failures = 0;
const results = [];
const browser = await chromium.launch({ headless: true });

async function sweep(context, routes, tag) {
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const badResponses = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 500) badResponses.push(`${r.status()} ${r.url()}`);
  });

  for (const route of routes) {
    pageErrors.length = 0;
    consoleErrors.length = 0;
    badResponses.length = 0;
    let status = 0,
      crashed = false,
      note = '';
    try {
      const resp = await page.goto(`${FRONT}${route}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      status = resp?.status() ?? 0;
      await page.waitForTimeout(2500); // let client hydrate + fetch
      const body = await page.locator('body').innerText();
      crashed =
        /Application error|Unhandled Runtime Error|This page could not be found/.test(
          body,
        ) && !/404-ok/.test(note);
      if (/This page could not be found/.test(body)) note = '404 page';
      const file = `docs/research/sweep/${tag}${route.replace(/\W+/g, '_') || '_home'}.png`;
      await page.screenshot({ path: file, fullPage: false });
    } catch (e) {
      crashed = true;
      note = String(e).slice(0, 120);
    }
    const ok =
      !crashed &&
      status < 500 &&
      pageErrors.length === 0 &&
      badResponses.length === 0;
    if (!ok) failures++;
    results.push({
      tag,
      route,
      status,
      ok,
      note,
      pageErrors: [...pageErrors],
      consoleErrors: [...consoleErrors].slice(0, 3),
      badResponses: [...badResponses].slice(0, 3),
    });
    console.log(
      `${ok ? 'PASS' : 'FAIL'} [${tag}] ${route} (doc ${status})${note ? ' — ' + note : ''}` +
        (pageErrors.length ? ` pageErrors=${pageErrors.length}` : '') +
        (badResponses.length ? ` 5xx=${badResponses.join(' | ')}` : '') +
        (consoleErrors.length ? ` consoleErr=${consoleErrors.length}` : ''),
    );
    for (const pe of pageErrors)
      console.log(`    pageerror: ${pe.slice(0, 200)}`);
    for (const ce of consoleErrors.slice(0, 3))
      console.log(`    console: ${ce.slice(0, 200)}`);
  }
  await page.close();
}

try {
  // derive /card/<handle> and /profile/<user> from live page anchors
  const probeCtx = await browser.newContext();
  const probe = await probeCtx.newPage();
  const derived = [];
  for (const [route, prefix] of [['/leaderboard', '/profile/']]) {
    try {
      await probe.goto(`${FRONT}${route}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await probe.waitForTimeout(2500);
      const href = await probe
        .locator(`a[href^="${prefix}"]`)
        .first()
        .getAttribute('href', { timeout: 5000 })
        .catch(() => null);
      if (href) derived.push(href);
      else console.log(`SKIP: no ${prefix}* anchor found on ${route}`);
    } catch {
      console.log(`SKIP: could not probe ${route} for ${prefix} links`);
    }
  }
  console.log(`derived routes: ${derived.join(', ') || '(none)'}`);
  PUBLIC.push(...derived);
  await probeCtx.close();

  // logged out: public routes + account routes (should redirect/teaser, not crash)
  const anonCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await sweep(anonCtx, [...PUBLIC, ...ACCOUNT], 'anon');
  await anonCtx.close();

  // logged in
  const authCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await authCtx.addCookies([
    {
      name: '_polycards_jwt',
      value: cust.token,
      url: FRONT,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await sweep(authCtx, [...PUBLIC, ...ACCOUNT], 'auth');
  await authCtx.close();
} finally {
  await browser.close();
}

console.log(`\n${results.length} route visits, ${failures} failures`);
process.exit(failures ? 1 : 0);
