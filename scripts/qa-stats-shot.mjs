// Screenshot the admin Stats page (English and 简体中文, desktop and phone)
// WITHOUT a password: the session comes from a token minted by
// backend/packages/api/src/scripts/qa-mint-admin-session.ts (QA_JWT_FILE),
// turned into the dashboard's cookie session via POST /auth/session.
// Requires backend :9000 + admin :7000 up.
//
// Usage: QA_JWT_FILE=/path/qa-admin.jwt [OUT=dir] [RANGE=30d] node scripts/qa-stats-shot.mjs
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:9000';
const ADMIN = process.env.ADMIN_URL || 'http://localhost:7000';
const OUT = process.env.OUT || 'docs/research';
const RANGE = process.env.RANGE || '30d';
mkdirSync(OUT, { recursive: true });

const jwtFile = process.env.QA_JWT_FILE;
if (!jwtFile) throw new Error('QA_JWT_FILE not set');
const token = readFileSync(jwtFile, 'utf8').trim();

// The preset button's label in each language (statsBoard.ranges.*).
const LABELS = {
  en: { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days' },
  zhCN: { today: '今天', '7d': '近7天', '30d': '近30天' },
};

const browser = await chromium.launch();

async function capture(lng, viewport, name) {
  const ctx = await browser.newContext({ viewport });
  // The dashboard's language detector reads the `lng` cookie first.
  await ctx.addCookies([{ name: 'lng', value: lng, url: ADMIN }]);
  const session = await ctx.request.post(`${BACKEND}/auth/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!session.ok())
    throw new Error(`POST /auth/session → ${session.status()}`);

  const page = await ctx.newPage();
  await page.goto(`${ADMIN}/dashboard/stats`, {
    waitUntil: 'domcontentloaded',
  });
  const button = page.getByRole('button', {
    name: LABELS[lng][RANGE],
    exact: true,
  });
  await button.waitFor({ timeout: 60000 });
  if (RANGE !== 'today') {
    const loaded = page.waitForResponse(
      (r) =>
        r.url().includes('/admin/stats') && r.url().includes(`range=${RANGE}`),
    );
    await button.click();
    const res = await loaded;
    if (!res.ok()) throw new Error(`GET /admin/stats → ${res.status()}`);
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/stats-${name}.png`, fullPage: true });
  await ctx.close();
}

await capture('en', { width: 1440, height: 900 }, `en-${RANGE}`);
await capture('zhCN', { width: 1440, height: 900 }, `zh-${RANGE}`);
await capture('zhCN', { width: 390, height: 844 }, `zh-${RANGE}-phone`);
await browser.close();
console.log(`wrote ${OUT}/stats-{en,zh}-${RANGE}*.png`);
