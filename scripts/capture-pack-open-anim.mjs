// Capture the new /claw/[slug] pack-opening reveal overlay, stage by stage, via
// the free demo spin (no auth needed — same overlay as a real open). Motion ON.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:4000";
const OUT = "docs/research/phase6/open-anim";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); // motion ON
const page = await ctx.newPage();
const r = { checks: {} };
const ok = (k, c, d) => (r.checks[k] = c ? "PASS" : `FAIL${d ? " — " + d : ""}`);

await page.goto(`${BASE}/claw/pokemon-mythic`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

const demo = page.getByRole("button", { name: /Try a free demo spin/i });
ok("demo_button", await demo.isVisible().catch(() => false));

// Fire the open, then grab frames across the stages (charge ~0-0.95s, burst ~1s,
// card flip ~1.1-2s, done ~2.1s+).
await demo.click();
const frames = [
  [350, "01-charge"],
  [1000, "02-burst"],
  [1350, "03-card-flip"],
  [2300, "04-done"],
];
let prev = 0;
const overlaySel = '[role="dialog"][aria-modal="true"]';
for (const [t, name] of frames) {
  await page.waitForTimeout(t - prev);
  prev = t;
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

// Assert the overlay reached the revealed state with a card + caption + actions.
const dlg = page.locator(overlaySel);
const text = await dlg.innerText().catch(() => "");
ok("overlay_open", await dlg.isVisible().catch(() => false));
ok("shows_you_pulled", /You pulled/i.test(text));
ok("shows_open_another", /Open another/i.test(text));
ok("shows_close", /Close/i.test(text));
ok("has_card_img", (await dlg.locator("img").count()) >= 1);

// Close via Escape (the overlay binds Escape once revealed); confirm it dismisses.
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
ok("closes", !(await dlg.isVisible().catch(() => false)));

await browser.close();
r.verdict = Object.values(r.checks).every((v) => v === "PASS") ? "PASS" : "FAIL";
console.log(JSON.stringify(r, null, 2));
