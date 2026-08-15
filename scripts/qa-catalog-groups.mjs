// QA: /slots two-group catalog (Graded / Raw) — headings, membership counts,
// screenshots. Run against a self-built server: node scripts/qa-catalog-groups.mjs [base]
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const browser = await chromium.launch();

const shoot = async (width, height, out) => {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${BASE}/slots`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200); // Reveal animations settle
  const headings = await page.locator('section h2').allInnerTexts();
  const counts = await page
    .locator('section span.ml-auto')
    .allInnerTexts()
    .catch(() => []);
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  return { headings, counts };
};

const desktop = await shoot(
  1440,
  900,
  'docs/research/qa-catalog-groups-desktop.png',
);
const mobile = await shoot(
  393,
  852,
  'docs/research/qa-catalog-groups-mobile.png',
);
console.log('desktop sections:', JSON.stringify(desktop));
console.log('mobile sections:', JSON.stringify(mobile));
await browser.close();
