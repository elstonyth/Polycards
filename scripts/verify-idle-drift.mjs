// Verify idle-drift on a big-pool pack (regression: rails frozen when pool > 50).
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
// Pack under test — diamond-pack is the prod repro (78-pair pool); a fresh
// local/e2e DB only has the QA packs, so point QA_PACK at one seeded big.
const PACK = process.env.QA_PACK ?? 'diamond-pack';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

await page.goto(`${BASE}/slots/${PACK}/spin?demo=1`, {
  waitUntil: 'networkidle',
});
const strip = page.locator('div.will-change-transform').first();
await strip.waitFor({ state: 'visible', timeout: 15000 });

// Strip cell count — always HREEL_STRIP_LEN (64); a sanity check that the
// reel actually mounted, NOT the pool size.
const cellCount = await strip.locator(':scope > div').count();

const t1 = await strip.evaluate((el) => el.style.transform);
await page.waitForTimeout(1500);
const t2 = await strip.evaluate((el) => el.style.transform);
await page.waitForTimeout(1500);
const t3 = await strip.evaluate((el) => el.style.transform);

console.log(JSON.stringify({ cellCount, t1, t2, t3 }, null, 2));
if (t1 === t2 && t2 === t3) {
  console.error('FAIL: strip transform did not change — rails frozen');
  process.exit(1);
}
console.log('PASS: idle drift active');
await page.screenshot({ path: 'docs/research/idle-drift-verify.png' });
await browser.close();
