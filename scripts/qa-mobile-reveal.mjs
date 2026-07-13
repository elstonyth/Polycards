// QA — spin-room responsiveness (mobile-first redesign of the reveal layout).
// For each viewport: open the demo spin room, assert the page/stage never
// scrolls (any direction), play a demo spin to the reveal, flip the card, and
// assert the slab + its footer actions sit fully inside the viewport.
// Prod build on :4000 (serve-standalone). Run: node scripts/qa-mobile-reveal.mjs
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const PACK = process.env.QA_PACK ?? 'pokemon-elite';

const VIEWPORTS = [
  { name: 'iphone-se', width: 320, height: 568 },
  { name: 'iphone-8', width: 375, height: 667 },
  { name: 'iphone-14', width: 390, height: 844 },
  { name: 'pixel-7', width: 412, height: 915 },
  { name: 'iphone-17-pro-max', width: 440, height: 956 },
  { name: 's27-ultra', width: 412, height: 952 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 860 },
];

// Viewports that also run the 3-reel batch pass (rail + peek checks).
const BATCH_VIEWPORTS = [
  'iphone-se',
  'iphone-8',
  'iphone-17-pro-max',
  's27-ultra',
];

let failures = 0;
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  failures += 1;
};
const ok = (m) => console.log(`  ✓ ${m}`);

// No scrolling anywhere: the document itself, plus every element that actually
// overflows its box (catches the stage container / reveal overlay).
async function assertNoScroll(page, label) {
  const res = await page.evaluate(() => {
    const doc = document.scrollingElement;
    const bad = [];
    if (doc.scrollHeight > doc.clientHeight + 1)
      bad.push(`document y (${doc.scrollHeight} > ${doc.clientHeight})`);
    if (doc.scrollWidth > doc.clientWidth + 1)
      bad.push(`document x (${doc.scrollWidth} > ${doc.clientWidth})`);
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      const scrollableY =
        (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 1;
      const scrollableX =
        (s.overflowX === 'auto' || s.overflowX === 'scroll') &&
        el.scrollWidth > el.clientWidth + 1;
      if (scrollableY || scrollableX) {
        const cls = (el.className || '').toString().slice(0, 80);
        bad.push(
          `${el.tagName.toLowerCase()}.${cls} (${scrollableX ? 'x' : 'y'}: ${
            scrollableX
              ? `${el.scrollWidth}>${el.clientWidth}`
              : `${el.scrollHeight}>${el.clientHeight}`
          })`,
        );
      }
    }
    return bad;
  });
  if (res.length === 0) ok(`${label}: nothing scrolls`);
  else fail(`${label}: scrollable → ${res.join(' | ')}`);
}

async function assertInViewport(page, locator, label, vp) {
  const box = await locator.boundingBox();
  if (!box) return fail(`${label}: not rendered`);
  const out =
    box.x < -1 ||
    box.y < -1 ||
    box.x + box.width > vp.width + 1 ||
    box.y + box.height > vp.height + 1;
  if (out)
    fail(
      `${label}: outside viewport (x=${Math.round(box.x)} y=${Math.round(
        box.y,
      )} w=${Math.round(box.width)} h=${Math.round(box.height)} in ${
        vp.width
      }x${vp.height})`,
    );
  else ok(`${label}: fully on-screen`);
}

const browser = await chromium.launch({ headless: true });
for (const vp of VIEWPORTS) {
  console.log(`\n── ${vp.name} (${vp.width}x${vp.height}) ──`);
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: true,
    isMobile: vp.width < 700,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/slots/${PACK}/spin?demo=1`, {
      waitUntil: 'networkidle',
    });
    const spinBtn = page.getByRole('button', { name: /demo spin/i });
    await spinBtn.waitFor({ timeout: 20000 });
    await assertNoScroll(page, 'idle machine');
    await assertInViewport(page, spinBtn, 'spin button', vp);
    await page.screenshot({
      path: `docs/research/qa-reveal-${vp.name}-idle.png`,
    });

    await spinBtn.click();
    const flip = page.getByRole('button', {
      name: 'Flip to reveal your card',
    });
    await flip.waitFor({ state: 'visible', timeout: 30000 });
    // wait for review phase (button enabled) — the real "ready" signal
    await page.waitForFunction(
      () =>
        !document
          .querySelector('button[aria-label="Flip to reveal your card"]')
          ?.hasAttribute('disabled'),
      { timeout: 30000 },
    );
    await page.waitForTimeout(600); // let the morph settle
    await assertNoScroll(page, 'reveal (face-down)');
    await assertInViewport(page, flip, 'face-down slab', vp);
    await page.screenshot({
      path: `docs/research/qa-reveal-${vp.name}-facedown.png`,
    });

    await flip.click({ force: true }); // idle float defeats stability check
    const cta = page.getByRole('button', { name: /sign up & pull for real/i });
    await cta.waitFor({ timeout: 10000 });
    await page.waitForTimeout(700); // flip + stamp settle
    await assertNoScroll(page, 'reveal (flipped)');
    // The card must not move on flip (spec #23), so the face-down bbox check
    // above already covers the flipped slab; assert the actions land on-screen.
    await assertInViewport(page, cta, 'primary action (sign-up CTA)', vp);
    await assertInViewport(
      page,
      page.getByRole('button', { name: /back to the reel/i }),
      'secondary action',
      vp,
    );
    await page.screenshot({
      path: `docs/research/qa-reveal-${vp.name}-flipped.png`,
    });
  } catch (err) {
    fail(`${vp.name}: ${err.message.split('\n')[0]}`);
    // best-effort — a crashed page must not abort the remaining viewports
    await page
      .screenshot({ path: `docs/research/qa-reveal-${vp.name}-error.png` })
      .catch(() => {});
  } finally {
    await ctx.close().catch(() => {});
  }
}
// ── 3-reel batch: the GalleryRail + "1 of 3" counter is the tightest vertical
// budget the reveal has, and the neighbor peek must show real card. ─────────
for (const vp of VIEWPORTS.filter((v) => BATCH_VIEWPORTS.includes(v.name))) {
  console.log(`\n── ${vp.name} ×3 reels (${vp.width}x${vp.height}) ──`);
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/slots/${PACK}/spin?demo=1&count=3`, {
      waitUntil: 'networkidle',
    });
    const spinBtn = page.getByRole('button', { name: /demo spin/i });
    await spinBtn.waitFor({ timeout: 20000 });
    await assertNoScroll(page, 'idle machine (3 reels)');
    await spinBtn.click();
    const flip = page
      .getByRole('button', { name: 'Flip to reveal your card' })
      .first();
    await flip.waitFor({ state: 'visible', timeout: 40000 });
    await page.waitForTimeout(1500); // 3-card stagger settles
    await assertNoScroll(page, 'reveal rail (face-down)');
    await assertInViewport(page, flip, 'active face-down slab', vp);
    // Neighbor peek: the NEXT card's slab must be visibly on-screen (≥24px
    // sliver) so the rail reads as swipeable — not empty rail gutter.
    const neighbor = await page
      .getByRole('button', { name: 'Flip to reveal your card' })
      .nth(1)
      .boundingBox();
    if (!neighbor) fail('neighbor slab: not rendered');
    else {
      const visible =
        Math.min(vp.width, neighbor.x + neighbor.width) -
        Math.max(0, neighbor.x);
      if (visible >= 24)
        ok(`neighbor peek: ${Math.round(visible)}px of next card visible`);
      else fail(`neighbor peek: only ${Math.round(visible)}px visible`);
    }
    await flip.click({ force: true });
    const cta = page
      .getByRole('button', { name: /sign up & pull for real/i })
      .first();
    await cta.waitFor({ timeout: 10000 });
    await page.waitForTimeout(700);
    await assertNoScroll(page, 'reveal rail (flipped)');
    await assertInViewport(page, cta, 'primary action', vp);
    await assertInViewport(page, page.getByText(/1 of 3/), 'rail counter', vp);
    await page.screenshot({
      path: `docs/research/qa-reveal-${vp.name}-3up.png`,
    });
  } catch (err) {
    fail(`${vp.name} ×3: ${err.message.split('\n')[0]}`);
    // best-effort — a crashed page must not abort the remaining viewports
    await page
      .screenshot({ path: `docs/research/qa-reveal-${vp.name}-3up-error.png` })
      .catch(() => {});
  } finally {
    await ctx.close().catch(() => {});
  }
}

await browser.close();

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nAll viewports pass — no scroll, everything on-screen.');
}
