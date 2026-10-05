// QA capture of the announcement popup (spec 2026-10-06 §5): first slide,
// second slide, and the page after closing — on a phone and on desktop.
// Usage:
//   PW_BASE=http://localhost:4100 node scripts/qa-announcement-popup.mjs
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4100';
const OUT = process.env.PW_OUT ?? 'docs/research';

const browser = await chromium.launch();

async function capture(viewport, suffix) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  // The popup waits for the cookie-consent answer before it opens.
  const reject = page.getByRole('button', { name: /reject/i });
  if (await reject.count())
    await reject
      .first()
      .click()
      .catch(() => {});
  const dialog = page.getByRole('dialog', { name: 'Announcements' });
  await dialog.waitFor({ timeout: 10000 });
  await page.waitForTimeout(900); // entry animation + image decode
  await page.screenshot({ path: `${OUT}/announcement-${suffix}-1.png` });

  const next = page.getByRole('button', { name: 'Show announcement 2' });
  if (await next.count()) {
    await next.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/announcement-${suffix}-2.png` });
  }

  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(400);
  const gone = (await dialog.count()) === 0;
  // Once per MYT day: a reload must not bring it back.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const back = (await dialog.count()) > 0;
  console.log(`${suffix}: closed=${gone} reappeared-after-reload=${back}`);
  await ctx.close();
}

await capture({ width: 390, height: 844 }, 'mobile');
await capture({ width: 1280, height: 900 }, 'desktop');
await browser.close();
