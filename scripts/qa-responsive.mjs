// Site-wide responsive/layout sweep. Drives every real route at six device
// widths and measures the page instead of eyeballing it.
//
// FAIL (breakage — the page is wrong at this size):
//   - horizontal page scroll
//   - an element sticking out past the viewport, ignoring anything inside an
//     overflow-clipped scroller (carousels park neighbours offscreen by design)
//   - text clipped by its own box (no ellipsis, no line-clamp)
//   - an interactive control below the WCAG 2.2 AA 24px target size
//   - the fixed tab bar covering the last footer content
//
// ADVISORY (sizing best-practice, reported not failed — some are deliberate):
//   - body text under 12px
//   - form inputs under 16px (iOS zooms the page on focus below that)
//   - text lines over 80ch (long measure hurts readability on wide screens)
//
// Usage:
//   node scripts/qa-responsive.mjs                  # everything
//   QA_PATHS=/,/slots node scripts/qa-responsive.mjs
//   QA_SHOTS=1 node scripts/qa-responsive.mjs       # also write screenshots
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const BACKEND = process.env.MEDUSA_BACKEND_URL ?? 'http://localhost:9000';
const PK = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY;
const SHOTS = process.env.QA_SHOTS === '1';

// Public routes plus one representative of each dynamic segment. Omitted on
// purpose: /marketplace + /pack-party (feature-flagged off — they 404),
// /daily (redirect to /vip), /slots/[slug]/spin (mid-flow, needs credits).
// The card handle below is a real catalog row (select handle from card); a
// stale one 404s and the run skips it rather than silently passing.
const PUBLIC = [
  '/',
  '/slots',
  '/slots/bronze-pack',
  '/leaderboard',
  '/task',
  '/how-it-works',
  '/fairness',
  '/about',
  '/contact',
  '/series',
  '/social',
  '/activity',
  '/airdrop',
  '/free',
  '/repacks',
  '/merchants',
  '/download',
  '/30th',
  '/roulette',
  '/reset-password',
  '/pokemon/generation/1',
  '/auth/google/failed',
  '/profile/ProfessorOak',
  '/invite/ProfessorOak',
  '/card/pikachu-ex-238-psa-10-7800271',
];

// Rendered against a freshly registered customer, so these are EMPTY-STATE
// layouts only — no orders, cards, transactions or vault items.
const AUTHED = [
  '/me',
  '/vault',
  '/wallet',
  '/orders',
  '/transactions',
  '/referrals',
  '/rewards',
  '/settings',
  '/addresses',
  '/notifications',
  '/vip',
  '/vouchers',
  '/bank-withdrawal',
];

const DEVICES = [
  { key: 'iphone-se', w: 320, h: 568 },
  { key: 'iphone-15', w: 390, h: 844 },
  { key: 'pixel-9', w: 412, h: 915 },
  { key: 'ipad-mini', w: 768, h: 1024 },
  { key: 'ipad-pro', w: 1024, h: 1366 },
  { key: 'desktop', w: 1440, h: 900 },
];

function audit() {
  const doc = document.documentElement;
  const clientW = doc.clientWidth;
  const label = (el) => {
    const cls =
      typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    const text = (el.textContent ?? '').trim().slice(0, 32);
    return `${el.tagName.toLowerCase()}${cls}${text ? ` "${text}"` : ''}`;
  };
  const insideClipper = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p);
      if (/hidden|auto|scroll|clip/.test(o.overflowX + o.overflow)) return true;
    }
    return false;
  };
  // sr-only content is a 1x1 clipped box on purpose.
  const srOnly = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.clipPath === 'inset(50%)' || s.clip === 'rect(0px, 0px, 0px, 0px)')
        return true;
    }
    return false;
  };

  const overflowing = [];
  const clipped = [];
  const smallTargets = [];
  const tinyText = [];
  const smallInputs = [];
  const longMeasure = [];

  for (const el of document.body.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (srOnly(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    if ((r.right > clientW + 1 || r.left < -1) && !insideClipper(el)) {
      overflowing.push({ el: label(el), right: Math.round(r.right) });
    }

    const leaf = el.children.length === 0;
    const hasText = leaf && (el.textContent ?? '').trim().length > 0;

    if (
      leaf &&
      el.scrollWidth > el.clientWidth + 1 &&
      /hidden|clip/.test(style.overflowX) &&
      style.textOverflow !== 'ellipsis' &&
      style.webkitLineClamp === 'none'
    ) {
      clipped.push({
        el: label(el),
        content: el.scrollWidth,
        box: el.clientWidth,
      });
    }

    const interactive =
      el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT';
    // WCAG 2.2 target-size (minimum) exempts targets in a sentence or block of
    // text — an inline-level link whose parent carries text around it.
    const inlineInText =
      style.display.startsWith('inline') &&
      [...(el.parentElement?.childNodes ?? [])].some(
        (n) => n !== el && (n.textContent ?? '').trim().length > 0,
      );
    if (
      interactive &&
      !inlineInText &&
      style.pointerEvents !== 'none' &&
      (r.width < 24 || r.height < 24)
    ) {
      smallTargets.push({
        el: label(el),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }

    const fs = parseFloat(style.fontSize);
    if (
      (el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT') &&
      fs < 16
    ) {
      smallInputs.push({ el: label(el), fontSize: fs });
    }
    // Sub-12px running text. Uppercase micro-labels are a deliberate part of
    // this design system, so they are counted, not itemised.
    if (hasText && fs < 12 && (el.textContent ?? '').trim().length > 24) {
      tinyText.push({ el: label(el), fontSize: fs });
    }
    // Measure: characters per line. ~80ch is the readability ceiling.
    if (hasText && (el.textContent ?? '').trim().length > 120) {
      const ch = r.width / (fs * 0.5);
      if (ch > 80) longMeasure.push({ el: label(el), ch: Math.round(ch) });
    }
  }

  const tabBar = [...document.querySelectorAll('nav[aria-label="Primary"]')]
    .map((n) => ({ n, s: getComputedStyle(n) }))
    .find((x) => x.s.position === 'fixed' && x.s.display !== 'none')?.n;
  const footerLast = document.querySelector('footer')?.lastElementChild;
  window.scrollTo(0, doc.scrollHeight);
  const tabTop = tabBar ? tabBar.getBoundingClientRect().top : null;
  const lastBottom = footerLast?.getBoundingClientRect().bottom ?? null;
  window.scrollTo(0, 0);

  return {
    hScroll: doc.scrollWidth > clientW + 1,
    tabBarCoversLast:
      tabTop != null && lastBottom != null ? lastBottom > tabTop + 1 : null,
    overflowing: overflowing.slice(0, 5),
    clipped: clipped.slice(0, 5),
    smallTargets: smallTargets.slice(0, 5),
    tinyText: tinyText.slice(0, 3),
    smallInputs: smallInputs.slice(0, 3),
    longMeasure: longMeasure.slice(0, 3),
  };
}

async function mintCustomer() {
  const call = async (path, { token, body } = {}) => {
    const res = await fetch(`${BACKEND}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(PK ? { 'x-publishable-api-key': PK } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  };
  const email = `pw-qa-${Date.now()}@polycards.local`;
  const password = 'PwE2e2026!';
  const reg = await call('/auth/customer/emailpass/register', {
    body: { email, password },
  });
  await call('/store/customers', {
    token: reg.token,
    body: { email, first_name: 'QA' },
  });
  const { token } = await call('/auth/customer/emailpass', {
    body: { email, password },
  });
  return token;
}

if (SHOTS) await mkdir('docs/research/responsive', { recursive: true });

const paths = process.env.QA_PATHS
  ? process.env.QA_PATHS.split(',').map((p) => [p, false])
  : [...PUBLIC.map((p) => [p, false]), ...AUTHED.map((p) => [p, true])];

const token = paths.some(([, a]) => a) ? await mintCustomer() : null;
const browser = await chromium.launch();

// A server serving a stale build 500s its stylesheet, and every page then
// measures as unstyled — images at natural size, no padding, tiny controls.
// That reads as a wall of real findings. Refuse to run instead.
{
  const probe = await browser.newPage();
  await probe.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const sheets = await probe.evaluate(() =>
    [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href),
  );
  const sizes = await Promise.all(
    sheets.map(async (href) => (await (await fetch(href)).text()).length),
  );
  await probe.close();
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total < 50_000) {
    console.error(
      `stylesheets total ${total} bytes across ${sheets.length} file(s) — the ` +
        `page is unstyled, so every measurement would be junk. Rebuild and ` +
        `restart the server (rm -rf .next && npm run build && serve-standalone).`,
    );
    await browser.close();
    process.exit(2);
  }
}
const rows = [];

for (const d of DEVICES) {
  const ctx = await browser.newContext({
    viewport: { width: d.w, height: d.h },
    isMobile: d.w < 700,
    hasTouch: d.w < 1100,
  });
  if (token) {
    await ctx.addCookies([
      {
        name: '_polycards_jwt',
        value: token,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  }
  const page = await ctx.newPage();
  for (const [path] of paths) {
    const res = await page
      .goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
      .catch(() => null);
    const status = res?.status() ?? 0;
    if (status !== 200) {
      rows.push({ path, device: d.key, status, skipped: true });
      console.log(`skip ${String(status).padStart(3)} ${path} @${d.w}`);
      continue;
    }
    await page
      .getByRole('button', { name: /reject/i })
      .click({ timeout: 1500 })
      .catch(() => {});
    const r = await page.evaluate(audit);
    const fail =
      r.hScroll ||
      r.overflowing.length > 0 ||
      r.clipped.length > 0 ||
      r.smallTargets.length > 0 ||
      r.tabBarCoversLast === true;
    rows.push({ path, device: d.key, width: d.w, status, fail, ...r });
    if (fail) console.log(`FAIL ${path} @${d.w} ${JSON.stringify(r)}`);
    if (SHOTS) {
      await page.screenshot({
        path: `docs/research/responsive/${path.replace(/\W+/g, '_') || 'home'}-${d.key}.png`,
        fullPage: true,
      });
    }
  }
  await ctx.close();
}
await browser.close();

await writeFile(
  'docs/research/qa-responsive.json',
  JSON.stringify(rows, null, 2),
);

const checked = rows.filter((r) => !r.skipped);
const failed = checked.filter((r) => r.fail);
const advisory = (key) => [
  ...new Set(checked.filter((r) => r[key]?.length).map((r) => r.path)),
];

console.log(`\n--- ${checked.length} page/viewport combos checked ---`);
console.log(`breakage failures: ${failed.length}`);
for (const p of [...new Set(failed.map((f) => f.path))]) {
  const widths = failed.filter((f) => f.path === p).map((f) => f.width);
  console.log(`  ${p} @ ${widths.join(', ')}`);
}
console.log(
  `\nadvisory — tiny body text (<12px): ${advisory('tinyText').join(', ') || 'none'}`,
);
console.log(
  `advisory — inputs <16px (iOS zoom): ${advisory('smallInputs').join(', ') || 'none'}`,
);
console.log(
  `advisory — measure >80ch:           ${advisory('longMeasure').join(', ') || 'none'}`,
);
const skipped = [
  ...new Set(
    rows.filter((r) => r.skipped).map((r) => `${r.path} (${r.status})`),
  ),
];
console.log(`\nnot checked (non-200): ${skipped.join(', ') || 'none'}`);
process.exit(failed.length === 0 ? 0 : 1);
