// Screenshot the admin partner-account generator WITHOUT a password: the
// session comes from a token minted by backend/packages/api/src/scripts/
// qa-mint-admin-session.ts (QA_JWT_FILE), turned into the dashboard's cookie
// session via POST /auth/session. Requires backend :9000 + admin :7000 up.
//
// Usage: QA_JWT_FILE=/path/qa-admin.jwt [OUT=dir] node scripts/qa-admin-shot.mjs
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:9000';
const ADMIN = process.env.ADMIN_URL || 'http://localhost:7000';
const OUT = process.env.OUT || 'docs/research';
mkdirSync(OUT, { recursive: true });

const jwtFile = process.env.QA_JWT_FILE;
if (!jwtFile) throw new Error('QA_JWT_FILE not set');
const token = readFileSync(jwtFile, 'utf8').trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});

// Bearer → cookie session (cookies are per host, so :9000's cookie reaches
// the SPA on :7000 exactly as it does after a normal login).
const session = await ctx.request.post(`${BACKEND}/auth/session`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!session.ok()) throw new Error(`POST /auth/session → ${session.status()}`);

const page = await ctx.newPage();
const shot = (name) =>
  page.screenshot({ path: `${OUT}/partner-accounts-${name}.png` });

await page.goto(`${ADMIN}/dashboard/players`, {
  waitUntil: 'domcontentloaded',
});
const openBtn = page.getByRole('button', { name: 'Generate partner accounts' });
await openBtn.waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
await shot('1-players');

await openBtn.click();
const dialog = page.getByRole('dialog');
await dialog.getByLabel('How many').waitFor({ timeout: 15000 });
await dialog.getByLabel('How many').fill('3');
await page.waitForTimeout(500);
await shot('2-modal');

// Group dropdown open, so the partner default + the alternatives are visible.
await dialog.locator('#create-player-group').click();
await page.waitForTimeout(500);
await shot('3-group-select');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
await dialog.getByText('accounts generated').waitFor({ timeout: 60000 });
await page.waitForTimeout(800);
await shot('4-generated');
const firstEmail = await dialog.locator('tbody td').nth(1).innerText();

await dialog.getByRole('button', { name: 'Done' }).click();
await page.getByText(firstEmail).first().waitFor({ timeout: 15000 });
await page.waitForTimeout(800);
await shot('5-players-after');

// The Players-page export: prove the .xlsx actually downloads.
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.getByRole('button', { name: 'Export partner logins' }).click(),
]);
const xlsx = `${OUT}/${download.suggestedFilename()}`;
await download.saveAs(xlsx);

console.log(`generated 3 (first ${firstEmail}); export saved to ${xlsx}`);
await browser.close();
