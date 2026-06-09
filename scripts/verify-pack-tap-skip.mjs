// Verify the pack-opening reveal is tap-advanceable (no forced 3s wait): each
// tap steps packs→slab→metadata→pull→card, a "Tap to continue" hint shows during
// the reveal, and the won card renders. Runs against the prod build on :4000.
//
// Run: node scripts/verify-pack-tap-skip.mjs
import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = process.env.BASE_URL ?? "http://localhost:4000";
const OUT = "docs/research/route-qa";
mkdirSync(OUT, { recursive: true });
const results = [];
const pass = (n, ok, note) => results.push({ name: n, ok: !!ok, note });

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/claw/pokemon-mythic`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /Try a free demo spin/i }).click();
  await page.waitForTimeout(800);
  pass("overlay open (cylinder)", await page.getByText(/Shuffle|Drag to spin/i).first().isVisible().catch(() => false));

  const cx = 720, cy = 450;
  await page.mouse.click(cx, cy); // packs → slab (tap a pack)
  await page.waitForTimeout(300);
  pass("slab shown after tapping a pack", await page.getByText(/Tap to reveal/i).first().isVisible().catch(() => false));

  // Rapid taps should step through to the card well under the ~3s auto-play.
  const t0 = Date.now();
  await page.mouse.click(cx, cy); // slab → metadata
  await page.waitForTimeout(140);
  const hint = await page.getByText(/Tap to continue/i).first().isVisible().catch(() => false);
  await page.mouse.click(cx, cy); // metadata → pull
  await page.waitForTimeout(140);
  await page.mouse.click(cx, cy); // pull → card
  await page.waitForTimeout(300);
  const elapsed = Date.now() - t0;

  pass("'Tap to continue' hint shown during reveal", hint);
  const continueBtn = await page.getByRole("button", { name: /^Continue$/ }).first().isVisible().catch(() => false);
  pass("reached card stage via taps", continueBtn, `${elapsed}ms`);
  pass("tap-advance beats auto-play (<1500ms)", elapsed < 1500, `${elapsed}ms`);
  const imgOk = await page.evaluate(() =>
    [...document.querySelectorAll("img")].some((i) => i.src.includes("/cdn/cards/") && i.naturalWidth > 50),
  );
  pass("won card image rendered", imgOk);
  await page.screenshot({ path: `${OUT}/pack-tapskip-card.png` });
  await ctx.close();
} finally {
  await browser.close();
}

let ok = 0;
for (const r of results) { console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`); if (r.ok) ok++; }
console.log(`\n${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
