// e2e: create a group with odds set 2, move a player into it, verify the
// odds-set counts follow. Screenshots each proof step.
// Run: QA_ADMIN_EMAIL=... QA_ADMIN_PW=... node scripts/shot-group-move.mjs
import { chromium } from 'playwright';

const ADMIN = 'http://localhost:7000/dashboard';
const OUT = process.env.OUT || 'docs/research';
const NAME = process.env.GROUP_NAME || 'whale';

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
p.on('pageerror', (e) => console.log('ERR', e.message.slice(0, 140)));

await p.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
const e = p.locator('input[name="email"]');
await e.waitFor({ state: 'visible', timeout: 30000 });
await e.fill(process.env.QA_ADMIN_EMAIL);
await p.fill('input[name="password"]', process.env.QA_ADMIN_PW);
await p.press('input[name="password"]', 'Enter');
await p.waitForURL((u) => !String(u).includes('/login'), { timeout: 30000 });
await p.waitForTimeout(3000);

// create the group already on odds set 2
await p.goto(`${ADMIN}/odds-sets`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
if ((await p.locator(`table tbody tr:has-text("${NAME}")`).count()) === 0) {
  await p.fill('#new-group-name', NAME);
  await p.locator('#new-group-set').click();
  await p.getByRole('option', { name: 'Set 2' }).click();
  await p.getByRole('button', { name: 'Create group' }).click();
  await p.waitForTimeout(3000);
}
await p.screenshot({
  path: `${OUT}/admin-odds-sets-created.png`,
  fullPage: true,
});
console.log('created group');

// move the first player into it
await p.goto(`${ADMIN}/players`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
await p.locator('table tbody tr').first().click();
await p.waitForTimeout(5000);
await p.locator('#player-group').click();
await p.getByRole('option', { name: `${NAME} — Odds set 2` }).click();
await p.getByRole('button', { name: 'Move player' }).click();
await p.waitForTimeout(4000);
await p.screenshot({ path: `${OUT}/admin-player-moved.png`, fullPage: true });
console.log('moved player', p.url());

// counts follow
await p.goto(`${ADMIN}/odds-sets`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(5000);
await p.screenshot({
  path: `${OUT}/admin-odds-sets-after.png`,
  fullPage: true,
});
console.log('done');
await b.close();
