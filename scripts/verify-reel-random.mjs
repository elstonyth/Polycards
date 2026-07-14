// scripts/verify-reel-random.mjs
// Verify the reel idle-strip randomization on the PROD build (:4000):
//   A. two fresh page loads show DIFFERENT idle Pokémon sequences;
//   B. after a guest demo spin, tapping through the reveal ("Tap the card to
//      reveal" -> "Back to the reel") back to idle, the strip is reshuffled
//      (differs from the same context's pre-spin sequence).
// Anonymous + ?demo=1 (guest-only demo) — no login needed.
// Run: node scripts/verify-reel-random.mjs   [QA_PACK=pokemon-elite]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const PACK = process.env.QA_PACK || 'pokemon-elite';

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

mkdirSync('docs/research', { recursive: true });
const browser = await chromium.launch({ headless: true });

// First reel strip's cell sprites, in strip order. The strip element is the
// only will-change-transform flex row inside the reel window (ReelStrip.tsx).
async function readStrip(page) {
  const strip = page.locator('div.will-change-transform').first();
  await strip.locator('img').first().waitFor({ timeout: 20000 });
  const srcs = await strip
    .locator('img')
    .evaluateAll((imgs) =>
      imgs.slice(0, 12).map((el) => el.getAttribute('src') || ''),
    );
  return srcs.join('|');
}

async function freshLoad() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 860 },
  });
  const page = await ctx.newPage();
  // The reel machine lives at the /spin subroute, not the pack detail page
  // itself (post-8a332ddc "mobile-first pack detail" split the detail page
  // into a static buy panel; ./spin?demo=1 is the guest-demo reel — see
  // src/app/slots/[slug]/spin/page.tsx).
  await page.goto(`${BASE}/slots/${PACK}/spin?demo=1`, {
    waitUntil: 'domcontentloaded',
  });
  return { ctx, page };
}

try {
  // ── A: two fresh loads differ ─────────────────────────────────────────────
  const a = await freshLoad();
  const seqA = await readStrip(a.page);
  await a.page.screenshot({ path: 'docs/research/reel-random-load-a.png' });

  let b = await freshLoad();
  let seqB = await readStrip(b.page);
  if (seqB === seqA) {
    // Small pools can collide legitimately (poolLen! orders); one retry.
    await b.ctx.close();
    b = await freshLoad();
    seqB = await readStrip(b.page);
  }
  await b.page.screenshot({ path: 'docs/research/reel-random-load-b.png' });
  if (seqB !== seqA) ok('two fresh loads show different idle sequences');
  else fail('idle sequence identical across two loads (+1 retry)');
  await b.ctx.close();

  // ── B: post-spin return-to-idle reshuffles ────────────────────────────────
  const preSpin = await readStrip(a.page);
  const spinBtn = a.page.getByRole('button', { name: /spin/i }).first();
  await spinBtn.click();
  // DEVIATION from the brief: in demo mode the reveal does NOT auto-conclude
  // to idle (#27 describes the real, logged-in keep/sell flow). The guest
  // demo theater requires two taps — the card, then "Back to the reel" — to
  // dismiss the reveal (verified live: the "Spin again" button stays disabled
  // through the card reveal until "Back to the reel" is clicked). Drive that
  // tap-through here instead of only waiting for auto-conclusion.
  await a.page.getByText('Tap the card to reveal').waitFor({ timeout: 15000 });
  await a.page.mouse.click(720, 340); // card back, centered (repo convention: qa-demo-spin.mjs)
  await a.page
    .getByRole('button', { name: /back to the reel/i })
    .click({ timeout: 15000 });
  await a.page.waitForFunction(
    () => {
      const btns = [...document.querySelectorAll('button')];
      const spin = btns.find((el) => /spin/i.test(el.textContent || ''));
      return spin && !spin.disabled;
    },
    { timeout: 90000 },
  );
  const postSpin = await readStrip(a.page);
  if (postSpin !== preSpin) ok('return-to-idle reshuffled the strip');
  else fail('strip unchanged after the spin cycle');
  await a.ctx.close();
} catch (err) {
  fail(err.message);
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'VERIFY: FAIL' : 'VERIFY: PASS');
