// Screenshot the admin "Create player" flow WITHOUT a password: the session
// comes from a token minted by backend/packages/api/src/scripts/
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
  page.screenshot({ path: `${OUT}/create-player-${name}.png` });

await page.goto(`${ADMIN}/dashboard/players`, {
  waitUntil: 'domcontentloaded',
});
const openBtn = page.getByRole('button', { name: 'Create player' });
await openBtn.waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
await shot('1-players');

await openBtn.click();
const dialog = page.getByRole('dialog');
await dialog.getByLabel('Email').waitFor({ timeout: 15000 });
await page.waitForTimeout(800);
await shot('2-modal');

// Group dropdown open, so the partner default + the alternatives are visible.
await dialog.locator('#create-player-group').click();
await page.waitForTimeout(500);
await shot('3-group-select');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

const email = await dialog.getByLabel('Email').inputValue();
await dialog.getByRole('button', { name: 'Create player' }).click();
await dialog.getByText('Player created').waitFor({ timeout: 30000 });
await page.waitForTimeout(800);
await shot('4-created');

await dialog.getByRole('button', { name: 'Done' }).click();
await page.getByText(email).first().waitFor({ timeout: 15000 });
await page.waitForTimeout(800);
await shot('5-players-after');

console.log(`created ${email}; screenshots in ${OUT}`);
await browser.close();
