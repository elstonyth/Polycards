// Deep recon of the LIVE phygitals pack-OPENING flow: drive /claw, click a pack,
// click "Open", and capture the resulting flow + any animation frame-by-frame.
// Determines what the real open experience is (modal? route? claw anim? login/pay
// wall? card reveal?) so the clone's pack-opening can be verified against it.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'docs/design-references/phygitals-open';
mkdirSync(OUT, { recursive: true });
const BASE = 'https://www.phygitals.com';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage();
const log = [];
const note = (k, v) => {
  log.push({ [k]: v });
};

const snapshot = async (label) => {
  const info = await page.evaluate(() => ({
    url: location.href,
    bodyText: (document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .slice(0, 260),
    videos: document.querySelectorAll('video').length,
    canvases: document.querySelectorAll('canvas').length,
    lottie: document.querySelectorAll(
      '[class*="lottie"],lottie-player,dotlottie-player',
    ).length,
    avifImgs: [...document.querySelectorAll('img')].filter((i) =>
      /\.avif/i.test(i.currentSrc || i.src),
    ).length,
    dialogs: document.querySelectorAll(
      '[role="dialog"],[class*="modal"],[class*="Modal"]',
    ).length,
    loginish:
      /log in|login|sign in|sign up|connect wallet|add funds|insufficient|buy credits|deposit/i.test(
        document.body?.innerText || '',
      ),
    buttons: [...document.querySelectorAll('button,a')]
      .map((b) => (b.innerText || '').trim())
      .filter((t) => t && t.length < 28)
      .slice(0, 30),
  }));
  return info;
};

// dismiss cookie / consent if present
async function dismissBanners() {
  for (const t of [/accept/i, /got it/i, /agree/i, /close/i]) {
    const b = page.getByRole('button', { name: t }).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

await page.goto(`${BASE}/claw`, {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(4500);
await dismissBanners();
await page.screenshot({ path: `${OUT}/flow-00-claw.png` });
note('claw_page', await snapshot('claw'));

// 1) Click a pack CARD (the pack art) to reach its detail/open UI.
const card = page.locator('img[src*="-icon.webp"]').first();
if (await card.isVisible().catch(() => false)) {
  await card.click().catch(() => {});
  await page.waitForTimeout(3500);
  await dismissBanners();
  await page.screenshot({ path: `${OUT}/flow-01-after-card-click.png` });
  note('after_card_click', await snapshot('card'));
}

// 2) Find + click an "Open" button (the open action).
let opened = false;
for (const re of [/^open$/i, /open pack/i, /^open/i, /play/i, /rip/i]) {
  const ob = page.getByRole('button', { name: re }).first();
  const ol = page.getByRole('link', { name: re }).first();
  const target = (await ob.isVisible().catch(() => false))
    ? ob
    : (await ol.isVisible().catch(() => false))
      ? ol
      : null;
  if (target) {
    await target.click().catch(() => {});
    opened = true;
    break;
  }
}
note('clicked_open', opened);

// 3) Film the post-open flow: 8 frames over ~7s to catch any animation.
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(900);
  await page.screenshot({
    path: `${OUT}/flow-02-open-${String(i).padStart(2, '0')}.png`,
  });
}
note('after_open', await snapshot('opened'));

await browser.close();
console.log(JSON.stringify(log, null, 2));
