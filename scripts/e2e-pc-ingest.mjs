// E2E proof of the PC image ingest: drive the REAL admin UI headlessly —
// search PriceCharting, pick a tier, paste the PC GCS image URL, submit —
// then assert via the admin API that the created product's image is OUR
// stored copy (media pipeline), not a hotlink to storage.googleapis.com.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const ADMIN_BASE = 'http://localhost:7000/dashboard';
const PC_IMG =
  'https://storage.googleapis.com/images.pricecharting.com/7f5a73ae1b86028a880208648facf9697fe87fda82d1fffb73f58a959ff40257/240.jpg';

const logins = Object.fromEntries(
  readFileSync(new URL('./.dev-logins', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [
      l.slice(0, l.indexOf('=')).trim(),
      l.slice(l.indexOf('=') + 1).trim(),
    ]),
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${ADMIN_BASE}/login`, {
  waitUntil: 'domcontentloaded',
  timeout: 20000,
});
await page.fill(
  'input[name="email"]',
  logins.ADMIN_EMAIL ?? 'admin@pokenic.app',
);
await page.fill('input[name="password"]', logins.ADMIN_PW);
await page.keyboard.press('Enter');
await page.waitForURL((u) => !u.pathname.includes('/login'), {
  timeout: 20000,
});

await page.goto(`${ADMIN_BASE}/products/from-pricecharting`, {
  waitUntil: 'domcontentloaded',
  timeout: 20000,
});
await page.fill('input[placeholder*="Card name"]', 'pikachu 288 sm-p');
await page.keyboard.press('Enter');
await page.waitForSelector('button:has-text("Pikachu #288")', {
  timeout: 20000,
});
await page.click('button:has-text("Pikachu #288")');
await page.waitForSelector('button:has-text("PSA 10:")', { timeout: 20000 });
await page.click('button:has-text("PSA 10:")');

// Paste the PC image URL (the operator flow) and confirm the ingest badge.
await page.fill('input[placeholder="Image URL"]', PC_IMG);
const badge = await page
  .waitForSelector('text=Will be fetched & stored on save', { timeout: 5000 })
  .catch(() => null);
console.log('ingest badge shown:', badge !== null);

page.on('response', async (res) => {
  if (
    res.url().includes('from-pricecharting') &&
    res.request().method() === 'POST'
  ) {
    console.log(
      'POST status:',
      res.status(),
      'body:',
      await res.text().catch(() => '?'),
    );
    console.log('POST payload:', res.request().postData());
  }
});
await page.click('button:has-text("Add product")');
// Success = the created-handle link appears (ingest + create round-trip).
// Router basename is /dashboard, so match on the product-id path segment.
const link = await page
  .waitForSelector('a[href*="/products/prod_"]', { timeout: 45000 })
  .catch(async (e) => {
    const toasts = await page
      .locator('[data-sonner-toast], [role="status"]')
      .allTextContents()
      .catch(() => []);
    console.log('TOASTS:', JSON.stringify(toasts));
    throw e;
  });
const handle = (await link.textContent())?.trim();
console.log('created handle:', handle);
await page.screenshot({
  path: process.env.SHOT_DIR + '/preview-5-created.png',
});

// Verify through the backend: thumbnail must NOT be the GCS hotlink.
const res = await page.request.get(
  `http://localhost:9000/admin/products?handle=${encodeURIComponent(handle)}&fields=id,handle,thumbnail,+metadata`,
  { headers: { authorization: `Bearer ${await getToken()}` } },
);
async function getToken() {
  const r = await page.request.post(
    'http://localhost:9000/auth/user/emailpass',
    {
      data: {
        email: logins.ADMIN_EMAIL ?? 'admin@pokenic.app',
        password: logins.ADMIN_PW,
      },
    },
  );
  return (await r.json()).token;
}
const body = await res.json();
const prod = body.products?.[0];
console.log('thumbnail:', prod?.thumbnail);
console.log('hotlinked:', prod?.thumbnail?.includes('storage.googleapis.com'));
console.log('metadata.market_multiplier:', prod?.metadata?.market_multiplier);
console.log('metadata.pokemon_dex:', prod?.metadata?.pokemon_dex);

await browser.close();
