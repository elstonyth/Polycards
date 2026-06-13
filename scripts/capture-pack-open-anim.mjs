// Capture the CLONE /claw/[slug] pack-opening overlay through its 5 live-matched stages
// (interactive 3D cylinder → drag-spin → tap → graded slab → metadata → PULL ribbon →
// graded-holder card) via the free demo spin. Motion ON. Verifies each stage.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const OUT = 'docs/research/phase6/open-anim';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
}); // motion ON
const page = await ctx.newPage();
const r = { checks: {} };
const ok = (k, c, d) =>
  (r.checks[k] = c ? 'PASS' : `FAIL${d ? ' — ' + d : ''}`);

await page.goto(`${BASE}/claw/pokemon-mythic`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.getByRole('button', { name: /Try a free demo spin/i }).click();
await page.waitForTimeout(700);

const dlg = page.locator('[role="dialog"][aria-modal="true"]');
ok('overlay_open', await dlg.isVisible().catch(() => false));

// Stage 1: cylinder
let txt = await dlg.innerText().catch(() => '');
ok('stage_packs', /tap a pack|shuffle|drag to spin/i.test(txt));
await page.screenshot({ path: `${OUT}/01-cylinder.png` });

// Test drag-to-spin: drag horizontally across the cylinder, screenshot the rotated state
const box = await dlg.boundingBox();
const cx = box.x + box.width / 2,
  cy = box.y + box.height / 2 - 40;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(cx - i * 24, cy);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/02-after-drag.png` });

// Tap a pack (a click, not a drag) → slab
await page.mouse.click(cx, cy);
await page.waitForTimeout(600);
txt = await dlg.innerText().catch(() => '');
ok('stage_slab', /tap to reveal|1 of 1/i.test(txt));
await page.screenshot({ path: `${OUT}/03-slab.png` });

// Tap slab → metadata
await page.mouse.click(cx, cy);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/04-metadata.png` });
txt = await dlg.innerText().catch(() => '');
ok('stage_metadata', /category|value|grade/i.test(txt));

// metadata → PULL (auto ~1.8s)
await page.waitForTimeout(1700);
await page.screenshot({ path: `${OUT}/05-pull.png` });
txt = await dlg.innerText().catch(() => '');
ok('stage_pull', /pull/i.test(txt));

// PULL → card (auto ~1.15s)
await page.waitForTimeout(1300);
await page.screenshot({ path: `${OUT}/06-card.png` });
txt = await dlg.innerText().catch(() => '');
ok('stage_card', /value:/i.test(txt));
ok('shows_continue', /Continue/i.test(txt));
ok('shows_open_another', /Open another/i.test(txt));
ok('has_card_img', (await dlg.locator('img').count()) >= 1);

await browser.close();
r.verdict = Object.values(r.checks).every((v) => v === 'PASS')
  ? 'PASS'
  : 'FAIL';
console.log(JSON.stringify(r, null, 2));
