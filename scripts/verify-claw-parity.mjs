// Phase 2 verification — /claw catalog/copy parity (frontend chunk):
// Dragon Ball chip + empty state, dynamic buyback %, horizontal carousel, and
// no stale "85% buyback" copy. Verifies against the prod build on :4000.
//
// Run: node scripts/verify-claw-parity.mjs   (needs `npx next start -p 4000`)
import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = process.env.BASE_URL ?? "http://localhost:4000";
const OUT = "docs/research/route-qa";
mkdirSync(OUT, { recursive: true });

const results = [];
const pass = (name, ok) => results.push({ name, ok: !!ok });

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/claw`, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("link", { name: "Open", exact: true }).first().waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${OUT}/claw-parity-1440.png` });

  // (b) Dragon Ball chip present + empty state on select
  const db = page.getByRole("button", { name: "Dragon Ball", exact: true });
  pass("Dragon Ball chip present", (await db.count()) > 0);
  await db.first().click();
  await page.waitForTimeout(500);
  const emptyVisible = await page.getByText(/No packs available/i).first().isVisible().catch(() => false);
  pass("Dragon Ball shows empty state", emptyVisible);
  await page.screenshot({ path: `${OUT}/claw-dragonball-empty-1440.png` });

  // (a) dynamic buyback badge + (d) carousel layout
  await page.getByRole("button", { name: "All Packs", exact: true }).click();
  await page.waitForTimeout(400);
  const boost90 = await page.getByText("+90% Buyback Boost").first().isVisible().catch(() => false);
  pass("boosted cards show +90% Buyback Boost", boost90);

  const carousel = await page.evaluate(() =>
    [...document.querySelectorAll("section > div")].some(
      (el) => el.className.includes("overflow-x-auto") && el.className.includes("flex"),
    ),
  );
  pass("category rows are horizontal carousels", carousel);

  // Backend-driven: premium Pokémon tiers at +92% and the Trainer out-of-stock tile.
  const boost92 = await page.getByText("+92% Buyback Boost").first().isVisible().catch(() => false);
  pass("premium tiers show +92% Buyback Boost", boost92);
  const oos = await page.getByText(/Out of Stock/i).first().isVisible().catch(() => false);
  pass("out-of-stock tile present", oos);

  // Scroll the Pokémon carousel to the end so the premium (+92%) + out-of-stock
  // tiles are in-frame for a visual proof shot.
  await page.locator("section > div.overflow-x-auto").first().evaluate((el) => { el.scrollLeft = el.scrollWidth; }).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/claw-premium-oos-1440.png` });

  // (a) no stale "85% buyback" copy — checked at mobile width (rows show the text)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/claw`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(500);
  const body = (await page.locator("body").innerText()).toLowerCase();
  pass("no stale '85% buyback' copy", !body.includes("85% buyback"));
  await page.screenshot({ path: `${OUT}/claw-parity-390.png` });

  await ctx.close();
} finally {
  await browser.close();
}

let ok = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  if (r.ok) ok++;
}
console.log(`\n${ok}/${results.length} checks passed`);
console.log(`screenshots → ${OUT}/claw-parity-{1440,390}.png, claw-dragonball-empty-1440.png`);
process.exit(ok === results.length ? 0 : 1);
