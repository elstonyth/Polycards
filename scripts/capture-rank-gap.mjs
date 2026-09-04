// Rank-gap card capture — the your-rank card on /leaderboard in each of its
// states, at the phone width the card was designed for.
//
// The card is gated on a logged-in session, so a logged-out shot proves
// nothing. This sets the storefront's httpOnly session cookie directly from a
// customer JWT rather than driving the login form — the page renders server
// side, so the cookie is the whole session.
//
// Usage (local only; backend on :9000, storefront standalone on :4000):
//   GAP_TOKENS=<path to json> node scripts/capture-rank-gap.mjs
// where the json is { "<label>": { "token": "<customer jwt>" }, ... }.
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';

const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4000';
const OUT = 'docs/research/rank-gap';
const TOKENS = process.env.GAP_TOKENS;
if (!TOKENS) throw new Error('GAP_TOKENS=<file.json> required');

const accounts = JSON.parse(await readFile(TOKENS, 'utf8'));
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const shot = async (label, token) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  if (token) {
    await ctx.addCookies([
      {
        name: '_polycards_jwt',
        value: token,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  }
  // Pre-record a cookie decision so the consent banner never renders — it is
  // fixed to the bottom of the viewport and covers the very card being shot.
  // 'rejected' is the privacy-preserving choice and leaves the session intact
  // (the storefront's session cookie is httpOnly and set server-side).
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem('polycards.cookie-consent', 'rejected');
    } catch {
      /* private mode — the banner just stays up */
    }
  });

  const page = await ctx.newPage();
  await page.goto(`${BASE}/leaderboard`, { waitUntil: 'domcontentloaded' });
  // The your-rank card is fixed above the tab bar; the standings above it lazy
  // in their avatars, so settle the network before shooting.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(600);

  // Read the card's own text so the run reports WHAT it captured, not just
  // that it captured something.
  const card = page
    .locator('div.fixed')
    .filter({ hasText: /Your rank/i })
    .first();
  const text = (await card.count())
    ? (await card.innerText()).replace(/\n+/g, ' | ')
    : '(no your-rank card — logged out)';
  console.log(`${label.padEnd(10)} ${text}`);

  await page.screenshot({ path: `${OUT}/${label}-full.png` });
  if (await card.count()) {
    await card.screenshot({ path: `${OUT}/${label}-card.png` });

    // Stress the copy at a figure far past anything the local fixture can
    // produce: the off-board line shares its row with the "Rip a pack" pill
    // inside a fixed max-w-md card, so a long RM figure is where it would
    // collide. Display-only DOM swap, purely to measure.
    const line = card
      .locator('p', { hasText: /to (top 10|#\d+)|Leading by/ })
      .first();
    if (await line.count()) {
      await line.evaluate((el) => {
        el.textContent = 'RM 1,234,567.89 to top 10';
      });
      const overlap = await card.evaluate((el) => {
        const p = [...el.querySelectorAll('p')].find((n) =>
          n.textContent?.includes('1,234,567.89'),
        );
        const pill = el.querySelector('a');
        if (!p) return null;
        const a = p.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const b = pill?.getBoundingClientRect();
        return {
          clipped: p.scrollWidth > p.clientWidth + 1,
          pastCard: a.right > box.right + 1,
          hitsPill: b ? a.right > b.left + 1 : false,
        };
      });
      console.log(`${''.padEnd(10)} stress: ${JSON.stringify(overlap)}`);
      await card.screenshot({ path: `${OUT}/${label}-stress.png` });
    }
  }
  await ctx.close();
};

for (const [label, acct] of Object.entries(accounts)) {
  await shot(label, acct.token);
}
await shot('loggedout', null);

await browser.close();
console.log(`\nwrote ${OUT}/`);
