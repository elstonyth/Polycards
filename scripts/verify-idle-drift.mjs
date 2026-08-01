// Verify idle-drift on a big-pool pack (regression: rails frozen when the
// decoy pool exceeded HREEL_IDLE_POOL_MAX — prod diamond-pack, 78 pairs).
import { chromium } from 'playwright';

// Mirrors src/lib/hreel.ts (STRIP_LEN 64, VISIBLE 9, BASE 5) — keep in sync.
const STRIP_LEN = 64;
const IDLE_POOL_MAX = 50;

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
// Pack under test — diamond-pack is the prod repro (78-pair pool); a fresh
// local/e2e DB only has the QA packs, so point QA_PACK at one seeded big.
const PACK = process.env.QA_PACK ?? 'diamond-pack';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  await page.goto(`${BASE}/slots/${PACK}/spin?demo=1`, {
    waitUntil: 'networkidle',
  });
  const strip = page.locator('div.will-change-transform').first();
  await strip.waitFor({ state: 'visible', timeout: 15000 });

  // Strip cell count — always HREEL_STRIP_LEN; sanity that the reel mounted.
  const cellCount = await strip.locator(':scope > div').count();
  // The idle strip is a pure tiling of the (capped) pool, so the number of
  // DISTINCT sprites across the 64 cells IS the rendered pool size — the
  // stable signal that the cap actually reached the reel.
  const poolSize = await strip.evaluate(
    (el) =>
      new Set(
        Array.from(el.querySelectorAll('img'), (img) =>
          img.getAttribute('src'),
        ),
      ).size,
  );

  const t1 = await strip.evaluate((el) => el.style.transform);
  await page.waitForTimeout(1500);
  const t2 = await strip.evaluate((el) => el.style.transform);
  await page.waitForTimeout(1500);
  const t3 = await strip.evaluate((el) => el.style.transform);

  console.log(JSON.stringify({ cellCount, poolSize, t1, t2, t3 }, null, 2));
  if (cellCount !== STRIP_LEN) {
    console.error(`FAIL: expected ${STRIP_LEN} strip cells, got ${cellCount}`);
    process.exitCode = 1;
  } else if (poolSize > IDLE_POOL_MAX) {
    console.error(
      `FAIL: rendered pool ${poolSize} exceeds the ${IDLE_POOL_MAX} cap`,
    );
    process.exitCode = 1;
  } else if (t1 === t2 && t2 === t3) {
    console.error('FAIL: strip transform did not change — rails frozen');
    process.exitCode = 1;
  } else {
    console.log('PASS: idle drift active, pool capped');
    await page.screenshot({ path: 'docs/research/idle-drift-verify.png' });
  }
} finally {
  await browser.close();
}
