// One-off QA capture: /privacy page + cookie-banner link + about mailto.
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

await page.goto(`${BASE}/privacy`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900); // Reveal animations
await page.screenshot({
  path: 'docs/research/qa-privacy-page.png',
  fullPage: true,
});

// Cookie banner link target (fresh context so consent is unset).
const banner = page.locator('a[href="/privacy"]');
const bannerCount = await banner.count();

// About page mailtos.
await page.goto(`${BASE}/about`, { waitUntil: 'networkidle' });
const mailtos = await page
  .locator('a[href^="mailto:"]')
  .evaluateAll((as) => as.map((a) => a.getAttribute('href')));

console.log(
  JSON.stringify({ bannerPrivacyLinks: bannerCount, mailtos }, null, 2),
);
await browser.close();
