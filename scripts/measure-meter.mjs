// scripts/measure-meter.mjs — measure the top-bar Meter's per-character boxes to
// confirm the "RM sits at a different height than the digits" report. Needs
// standalone :4000 + a logged-in customer (balance renders the credit meter).
import { chromium } from 'playwright';

const BASE = process.env.QA_BASE ?? 'http://localhost:4000';
const SLUG = process.env.QA_PACK_SLUG ?? 'pokemon-rookie';
const EMAIL = process.env.PW_CUSTOMER_EMAIL;
const PASSWORD = process.env.PW_CUSTOMER_PASSWORD;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

if (EMAIL && PASSWORD) {
  await page.goto(`${BASE}/slots/${SLUG}`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.locator('input[name="email"]').waitFor({ state: 'visible' });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.getByRole('button', { name: /^log in$/i }).click();
  await page
    .locator('input[name="email"]')
    .waitFor({ state: 'detached', timeout: 15000 });
}
await page.goto(`${BASE}/slots/${SLUG}/spin?count=1`, {
  waitUntil: 'domcontentloaded',
});
// Wait for the credit meter to hydrate: a SPAN.tabular-nums that actually
// contains child spans (the rolling digit cells) — not the Wins <p>.
await page
  .waitForFunction(
    () =>
      [...document.querySelectorAll('span.tabular-nums')].some((s) =>
        s.querySelector('span'),
      ),
    { timeout: 12000 },
  )
  .catch(() => {});
await page.waitForTimeout(400);

const rows = await page.evaluate(() => {
  const meter = [...document.querySelectorAll('span.tabular-nums')].find((s) =>
    s.querySelector('span'),
  );
  if (!meter) return null;
  // Measure GLYPH INK baselines via Range, not span boxes. R/M and digits have
  // no descender, so a Range's bottom edge == the glyph baseline. Aligned text
  // means every baseline shares one Y.
  const rangeBottom = (node) => {
    const rng = document.createRange();
    rng.selectNodeContents(node);
    return rng.getBoundingClientRect().bottom;
  };
  const kids = [...meter.children].filter((el) => el.tagName === 'SPAN');
  const out = [];
  for (const el of kids) {
    const txt = (el.textContent ?? '').trim();
    if (!txt || el.className.includes('sr-only')) continue;
    const rollingCol = el.querySelector('.flex-col');
    if (rollingCol) {
      const val = Math.round(
        Math.abs(
          parseFloat(
            (rollingCol.style.transform.match(/-?\d+(\.\d+)?/) ?? ['0'])[0],
          ),
        ),
      );
      const digitSpan = rollingCol.children[val];
      if (digitSpan)
        out.push({
          ch: digitSpan.textContent,
          kind: 'digit',
          baseline: Math.round(rangeBottom(digitSpan) * 10) / 10,
        });
    } else {
      out.push({
        ch: txt.slice(0, 1),
        kind: 'letter/sep',
        baseline: Math.round(rangeBottom(el) * 10) / 10,
      });
    }
  }
  return out;
});

if (!rows) {
  console.log('meter not found (not logged in / balance null?)');
} else {
  console.log('char  kind        baseline');
  for (const r of rows)
    console.log(
      `${JSON.stringify(r.ch).padEnd(5)} ${r.kind.padEnd(11)} ${String(r.baseline).padStart(8)}`,
    );
  const bl = rows.map((r) => r.baseline);
  console.log(
    `\nGLYPH BASELINE spread: ${(Math.max(...bl) - Math.min(...bl)).toFixed(1)}px (0 = perfectly aligned)`,
  );
}
await page.screenshot({
  path: 'docs/research/meter-before.png',
  clip: { x: 60, y: 20, width: 300, height: 80 },
});
await browser.close();
