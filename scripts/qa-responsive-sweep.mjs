// qa-responsive-sweep.mjs — phone-width sweep of EVERY storefront route.
//
// For each route × width × auth state it reports:
//   overflowX  — document.scrollWidth - innerWidth (>0 = page pans sideways)
//   spill      — elements whose box extends past the viewport edge and are NOT
//                inside an intentional overflow-x:auto/hidden rail
//   clipped    — text elements whose content is wider than their box with no
//                ellipsis (words cut off / spilling over neighbours)
// and writes a full-page screenshot per route (at the LAST width in WIDTHS).
//
// Usage: node scripts/qa-responsive-sweep.mjs [baseUrl] [outDir]
//   env WIDTHS=360,440   env AUTH=0 to skip the logged-in pass
// Needs scripts/.dev-logins (CUST_EMAIL / CUST_PW) for the logged-in pass.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const OUT = process.argv[3] ?? 'docs/research/resp-sweep';
const WIDTHS = (process.env.WIDTHS ?? '360,440').split(',').map(Number);
const SHOT_W = WIDTHS[WIDTHS.length - 1];
mkdirSync(OUT, { recursive: true });

const STATIC = [
  '/',
  '/slots',
  '/how-it-works',
  '/leaderboard',
  '/task',
  '/referral',
  '/about',
  '/contact',
  '/fairness',
  '/download',
  '/privacy',
  '/reset-password',
  '/auth/google/failed',
  '/bank-withdrawal',
];
const ACCOUNT = [
  '/me',
  '/wallet',
  '/vault',
  '/orders',
  '/transactions',
  '/addresses',
  '/bank',
  '/notifications',
  '/settings',
];

const logins = existsSync('scripts/.dev-logins')
  ? Object.fromEntries(
      readFileSync('scripts/.dev-logins', 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('=') && !l.startsWith('#'))
        .map((l) => [
          l.slice(0, l.indexOf('=')).trim(),
          l.slice(l.indexOf('=') + 1).trim(),
        ]),
    )
  : {};

// Runs in the page. Returns the three signals described in the header.
const PROBE = () => {
  const vw = document.documentElement.clientWidth; // NOT innerWidth: mobile emulation zooms innerWidth out to match overflowing content
  const de = document.documentElement;
  const overflowX = Math.max(0, de.scrollWidth - vw);
  const clips = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip')
        return true;
    }
    return false;
  };
  const label = (el) => {
    const cls = (el.getAttribute('class') ?? '')
      .split(/\s+/)
      .slice(0, 5)
      .join(' ');
    const txt = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `<${el.tagName.toLowerCase()} class="${cls}"> "${txt}"`;
  };
  const spill = [];
  const clipped = [];
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if ((r.right > vw + 1 || r.left < -1) && !clips(el)) {
      spill.push(
        `${label(el)} left=${Math.round(r.left)} right=${Math.round(r.right)}`,
      );
    }
    // Text wider than its box: only leaf-ish elements with direct text.
    const hasText = [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent.trim(),
    );
    if (
      hasText &&
      el.scrollWidth > el.clientWidth + 2 &&
      cs.textOverflow !== 'ellipsis' &&
      cs.overflowX === 'visible'
    ) {
      clipped.push(`${label(el)} sw=${el.scrollWidth} cw=${el.clientWidth}`);
    }
  }
  return { overflowX, spill: spill.slice(0, 8), clipped: clipped.slice(0, 8) };
};

const browser = await chromium.launch();
const report = [];

async function sweep(auth) {
  const ctx = await browser.newContext({
    viewport: { width: SHOT_W, height: 900 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce', // Reveal renders immediately → full-page shots show everything
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) =>
    console.log('  pageerror:', e.message.slice(0, 120)),
  );

  await page.goto(BASE + '/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page
    .getByRole('button', { name: 'Accept' })
    .click({ timeout: 4000 })
    .catch(() => {});

  if (auth) {
    const loginBtn = page
      .locator('header')
      .getByRole('button', { name: /^login$/i });
    await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
    await loginBtn.click();
    const email = page.locator('input[name="email"]');
    await email.waitFor({ state: 'visible', timeout: 20000 });
    await email.fill(logins.CUST_EMAIL || 'test@polycards.app');
    await page.fill('input[name="password"]', logins.CUST_PW ?? '');
    await page.keyboard.press('Enter');
    await loginBtn.waitFor({ state: 'detached', timeout: 20000 });
    console.log('login: ok');
  }

  // Discover dynamic routes from the live pages.
  const hrefs = async (url, prefix, n = 2) => {
    await page.goto(BASE + url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(1500);
    const all = await page.$$eval(`a[href^="${prefix}"]`, (as) =>
      as.map((a) => a.getAttribute('href')),
    );
    return [
      ...new Set(
        all.map((h) => h?.split('?')[0]).filter((h) => h && h !== prefix),
      ),
    ].slice(0, n);
  };
  const packs = await hrefs('/slots', '/slots/', 2);
  const cards = await hrefs('/', '/card/', 1);
  const profiles = await hrefs('/leaderboard', '/profile/', 1);
  // env ROUTES=/a,/b restricts the sweep to just those paths (re-check a fix).
  const routes = process.env.ROUTES?.split(',') ?? [
    ...STATIC,
    ...packs,
    ...(packs[0] ? [`${packs[0]}/spin`] : []),
    ...cards,
    ...profiles,
    ...(auth ? ACCOUNT : []),
  ];
  console.log(`routes (${auth ? 'auth' : 'anon'}):`, routes.length);

  for (const route of routes) {
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page
        .goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch((e) => console.log('  nav fail', route, e.message.slice(0, 80)));
      await page.waitForTimeout(1800);
      const r = await page.evaluate(PROBE);
      const bad = r.overflowX > 0 || r.spill.length || r.clipped.length;
      const tag = `[${auth ? 'auth' : 'anon'} ${w}] ${route}`;
      console.log(
        `${bad ? 'FAIL' : 'ok  '} ${tag} overflowX=${r.overflowX} spill=${r.spill.length} clipped=${r.clipped.length}`,
      );
      for (const s of r.spill) console.log('    spill:', s);
      for (const c of r.clipped) console.log('    clip :', c);
      report.push({ auth, w, route, ...r });
      if (w === SHOT_W) {
        const name = `${auth ? 'auth' : 'anon'}-${w}-${route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}.png`;
        await page
          .screenshot({ path: path.join(OUT, name), fullPage: true })
          .catch((e) => console.log('  shot fail', e.message.slice(0, 80)));
      }
    }
  }
  await ctx.close();
}

await sweep(false);
if (process.env.AUTH !== '0') await sweep(true);
await browser.close();
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const fails = report.filter(
  (r) => r.overflowX > 0 || r.spill.length || r.clipped.length,
);
console.log(
  `\n${fails.length}/${report.length} route×width combos flagged. Report: ${OUT}/report.json`,
);
