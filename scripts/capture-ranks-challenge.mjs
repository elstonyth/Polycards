// Verify the Weekly Pulled Value Challenge after its move from /task to the
// Ranks tab (/leaderboard): challenge block on top, standings below. Shoots
// mobile / tablet / desktop and reports any horizontal overflow (the stage
// carousel sizes rail items from the viewport, so a narrow container clips it).
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const SIZES = [
  { key: 'mobile', width: 390, height: 844 },
  { key: 'tablet', width: 768, height: 1024 },
  { key: 'desktop', width: 1280, height: 900 },
];

const browser = await chromium.launch();
for (const s of SIZES) {
  const page = await browser.newPage({
    viewport: { width: s.width, height: s.height },
  });
  await page.goto(`${BASE}/leaderboard`, { waitUntil: 'networkidle' });

  const report = await page.evaluate(() => ({
    h1: [...document.querySelectorAll('h1')].map((n) => n.textContent.trim()),
    hasChallenge: !!document.querySelector('[aria-label="Community progress"]'),
    hasStandings: !!document.querySelector('[aria-label="Standings"]'),
    // Section order down the page — rules must come last.
    order: [
      ...document.querySelectorAll(
        '[aria-label="Community progress"],[aria-label="Standings"],[aria-label="How it works"]',
      ),
    ].map((n) => n.getAttribute('aria-label')),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    // Prize thumbnails link to /card/<handle> (the "View Details" affordance).
    // The ratio check is the point: SlabImage holds its aspect only while ONE
    // dimension stays auto, so any caller that pins both (a stray `w-full`)
    // silently stretches the prism band into a landscape smear. That shipped
    // once; a link count alone did not catch it.
    prizeLinks: [...document.querySelectorAll('a[href^="/card/"]')].length,
    slabRatios: [
      ...new Set(
        [...document.querySelectorAll('a[href^="/card/"] [data-slab]')].map(
          (n) => {
            const r = n.getBoundingClientRect();
            return r.height > 0 ? (r.width / r.height).toFixed(2) : 'n/a';
          },
        ),
      ),
    ],
  }));
  console.log(s.key, JSON.stringify(report));
  // ~0.59 is SLAB_ASPECT. A 3D-transformed carousel neighbour reads slightly
  // off, hence the band rather than an equality check.
  const stretched = report.slabRatios.filter((r) => Number(r) > 0.7);
  if (stretched.length > 0) {
    console.error(
      `  ✗ ${s.key}: slab aspect broken (${stretched.join(', ')}) — a caller is pinning both width and height`,
    );
    process.exitCode = 1;
  }

  await page.screenshot({
    path: `docs/research/ranks-challenge-${s.key}.png`,
    fullPage: true,
  });
  await page.close();
}

// Logged-in pass: the your-rank card is fixed above the tab bar, so the page's
// last block needs clearance. Mint a throwaway customer straight against the
// backend and hand Playwright the same httpOnly JWT cookie the server action
// would set (src/lib/data/customer.ts).
const BACKEND = process.env.MEDUSA_BACKEND_URL ?? 'http://localhost:9000';
const PK = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY;

async function backend(path, { token, body, method = 'POST' } = {}) {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(PK ? { 'x-publishable-api-key': PK } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

const email = `pw-ranks-${Date.now()}@polycards.local`;
const password = 'PwE2e2026!';
const reg = await backend('/auth/customer/emailpass/register', {
  body: { email, password },
});
await backend('/store/customers', {
  token: reg.token,
  // Username is the public profile URL and unique — keep it per-run like the
  // email above, or the next run collides with this one's customer.
  body: { email, first_name: `PWRanks${Date.now()}`.slice(0, 30) },
});
const { token } = await backend('/auth/customer/emailpass', {
  body: { email, password },
});

const authed = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
await authed.addCookies([
  {
    name: '_polycards_jwt',
    value: token,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  },
]);
const inPage = await authed.newPage();
await inPage.goto(`${BASE}/leaderboard`, { waitUntil: 'networkidle' });
console.log(
  'logged-in',
  JSON.stringify(
    await inPage.evaluate(() => {
      const rules = document.querySelector('[aria-label="How it works"]');
      const standings = document.querySelector('[aria-label="Standings"]');
      const spacer = document.querySelector('div[aria-hidden].h-24');
      return {
        signedIn: !!document.querySelector('[href="/me"]'),
        // Gap between the standings block and the rules — a stray clearance
        // spacer wedged between them shows up here.
        gapStandingsToRules:
          rules && standings
            ? Math.round(
                rules.getBoundingClientRect().top -
                  standings.getBoundingClientRect().bottom,
              )
            : null,
        // The clearance must be the page's last block, after the rules.
        spacerAfterRules:
          spacer && rules
            ? !!(
                rules.compareDocumentPosition(spacer) &
                Node.DOCUMENT_POSITION_FOLLOWING
              )
            : null,
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      };
    }),
  ),
);
await inPage.screenshot({
  path: 'docs/research/ranks-challenge-loggedin.png',
  fullPage: true,
});
await authed.close();

// The Task tab is now a placeholder — check it points at Ranks.
const task = await browser.newPage({ viewport: { width: 390, height: 844 } });
await task.goto(`${BASE}/task`, { waitUntil: 'networkidle' });
console.log(
  'task',
  JSON.stringify({
    h1: (await task.locator('h1').first().textContent())?.trim(),
    link: await task.locator('a[href="/leaderboard"]').first().textContent(),
  }),
);
await task.screenshot({ path: 'docs/research/ranks-task-placeholder.png' });
await browser.close();
