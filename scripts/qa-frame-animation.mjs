// Verify the animated frame: login -> /me -> the frame canvas goes live and
// actually MOVES (two captures 700ms apart must differ), and the public
// profile page animates too. Reduced-motion must stay static.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT_DIR ?? '.';
mkdirSync(OUT, { recursive: true });
const kv = Object.fromEntries(
  readFileSync(path.join(process.cwd(), 'scripts', '.dev-logins'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [
      l.slice(0, l.indexOf('=')).trim(),
      l.slice(l.indexOf('=') + 1).trim(),
    ]),
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://127.0.0.1:4000/', { waitUntil: 'domcontentloaded' });
const loginBtn = page
  .locator('header')
  .getByRole('button', { name: /^login$/i });
await loginBtn.waitFor({ state: 'visible', timeout: 60000 });
await loginBtn.click();
const email = page.locator('input[name="email"]');
await email.waitFor({ state: 'visible', timeout: 20000 });
await email.fill(kv.CUST_EMAIL || 'test@pokenic.app');
await page.fill('input[name="password"]', kv.CUST_PW);
await page.keyboard.press('Enter');
await loginBtn.waitFor({ state: 'detached', timeout: 20000 });

await page.goto('http://127.0.0.1:4000/me', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500); // texture load + shader boot
const canvas = page.locator('header ~ * canvas, main canvas, canvas').first();
const count = await page.locator('canvas').count();
console.log('canvas elements on /me:', count);
if (count) {
  const visible = await canvas.evaluate(
    (el) => getComputedStyle(el).visibility,
  );
  console.log('canvas visibility:', visible);
  const shot = () => canvas.screenshot().then((b) => b.toString('base64'));
  const a = await shot();
  await page.waitForTimeout(700);
  const b = await shot();
  console.log(
    `motion check: frames ${a === b ? 'IDENTICAL — FAIL' : 'differ — PASS'}`,
  );
  await page.screenshot({
    path: `${OUT}/me-animated.png`,
    clip: { x: 0, y: 60, width: 500, height: 220 },
  });
}

// public profile page (demo-rs)
await page.goto('http://127.0.0.1:4000/profile/demo-rs', {
  waitUntil: 'networkidle',
});
await page.waitForTimeout(2500);
console.log('canvas on profile page:', await page.locator('canvas').count());
await page.screenshot({
  path: `${OUT}/profile-animated.png`,
  clip: { x: 0, y: 60, width: 600, height: 320 },
});

// reduced motion -> static img, no canvas
const rmPage = await browser.newPage({ reducedMotion: 'reduce' });
await rmPage.goto('http://127.0.0.1:4000/profile/demo-rs', {
  waitUntil: 'networkidle',
});
await rmPage.waitForTimeout(1500);
console.log(
  'reduced-motion canvas count (want 0 live):',
  await rmPage.locator('canvas:visible').count(),
);
await browser.close();
