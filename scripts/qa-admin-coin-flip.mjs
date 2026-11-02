// Built admin UI with intercepted local API responses; no live settings writes.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const out = path.resolve('.superpowers/sdd/2026-10-28-vault-coin-flip/qa');
await mkdir(out, { recursive: true });
const app = spawn(
  process.execPath,
  [
    '../../node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '7030',
  ],
  {
    cwd: path.resolve('backend/apps/admin'),
    windowsHide: true,
    stdio: 'ignore',
  },
);
const browser = await chromium.launch();
let settings = {
  enabled: false,
  revision: 7,
  published_win_percent: 50,
  win_percent: 48,
  win_percent_2: null,
  win_percent_3: 0,
};
let conflict = false;
const saves = [];
const historyRequests = [];
const errors = [];
try {
  for (let i = 0; i < 80; i++) {
    try {
      await fetch('http://127.0.0.1:7030/dashboard/coin-flips');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost:9000/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    let status = 200;
    if (url.pathname === '/admin/users/me')
      body = {
        user: {
          id: 'user_qa',
          email: 'qa@example.test',
          first_name: 'QA',
          last_name: 'Admin',
        },
      };
    else if (url.pathname === '/admin/feature-flags')
      body = { feature_flags: { rbac: false } };
    else if (url.pathname === '/admin/stores')
      body = {
        stores: [{ id: 'store_qa', name: 'Polycards' }],
        count: 1,
        offset: 0,
        limit: 10,
      };
    else if (url.pathname === '/admin/notifications')
      body = { notifications: [], count: 0, offset: 0, limit: 1 };
    else if (url.pathname === '/admin/coin-flips/settings') {
      if (request.method() === 'POST') {
        const data = request.postDataJSON();
        saves.push(data);
        if (conflict) {
          status = 409;
          body = {
            message: 'Coin flip settings changed. Reload before saving.',
          };
        } else {
          const { reason: _reason, expected_revision, ...values } = data;
          assert.equal(expected_revision, settings.revision);
          settings = { ...values, revision: settings.revision + 1 };
          body = settings;
        }
      } else body = settings;
    } else if (url.pathname === '/admin/coin-flips') {
      historyRequests.push(url.searchParams);
      body = {
        rounds: [
          {
            id: 'cfr_qa',
            status: 'lost',
            customer_id: 'c_qa',
            pull_id: 'pull_qa',
            stake_amount: 100,
            win_amount: 0,
            published_win_percent: 50,
            settled_at: '2026-10-28T12:00:00.000Z',
            config_revision: 7,
            roll: 900000,
            credit_transaction_id: null,
            chosen_side: 'head',
            landed_side: 'tail',
            cards: [
              { pull_id: 'pull_qa', name: 'Pikachu PSA 10', stake_amount: 100 },
            ],
            card: {
              name: 'Pikachu PSA 10',
              image: null,
              grader: 'PSA',
              grade: '10',
            },
            snapshot: {
              group_id: 'group_qa',
              odds_set: 3,
              actual_win_units: 0,
              published_win_units: 500000,
              source: 'gift',
              bonus_bp: 10000,
              valuation: {
                value_usd: 20,
                multiplier: 1.1,
                fx: 4.545454,
                quoted_at: '2026-10-28T11:59:30.000Z',
              },
            },
          },
        ],
        count: 1,
        limit: 25,
        offset: 0,
        totals: { wins: 0, losses: 1, payouts: 0, forfeited_value: 100 },
      };
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
      headers: {
        'access-control-allow-origin': 'http://127.0.0.1:7030',
        'access-control-allow-credentials': 'true',
      },
    });
  });
  await page.goto('http://127.0.0.1:7030/dashboard/coin-flips');
  await page.getByLabel('Published win odds (%)').waitFor();
  assert.equal(
    await page.getByLabel('Maximum total stake per flip (RM)').count(),
    0,
  );
  assert.equal(await page.getByLabel('Enable coin flips').isChecked(), false);
  assert(
    await page.getByText('Published odds differ', { exact: false }).isVisible(),
  );
  await page.getByLabel('Actual odds · Set 2 (%)').fill('0');
  await page
    .getByLabel('Audit reason', { exact: true })
    .fill('QA reviewed settings');
  await page.getByRole('tab', { name: 'History & forfeited cards' }).click();
  await page.keyboard.press('Control+s');
  assert.equal(saves.length, 0, 'Hidden settings cannot save by shortcut');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  assert.equal(
    await page.getByLabel('Actual odds · Set 2 (%)').inputValue(),
    '0',
    'Draft survives tabs',
  );
  assert.equal(
    await page.getByLabel('Audit reason', { exact: true }).inputValue(),
    'QA reviewed settings',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Paused · revision 8', { exact: true }).waitFor();
  assert.equal(saves[0].win_percent_2, 0);
  assert.equal(saves[0].published_win_percent, 50);
  assert.equal(saves[0].expected_revision, 7);
  await page.screenshot({ path: `${out}/admin-settings.png`, fullPage: true });
  const a11y = await new AxeBuilder({ page })
    .include('section[aria-label="Vault coin flip"]')
    .analyze();
  assert.deepEqual(
    a11y.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target).join(',')}`,
    ),
    [],
  );
  conflict = true;
  await page.getByLabel('Actual odds · Set 1 (%)').fill('47');
  await page
    .getByLabel('Audit reason', { exact: true })
    .fill('Concurrent edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByText('Another admin changed these settings.', { exact: false })
    .waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
    true,
  );
  settings = { ...settings, revision: 9 };
  conflict = false;
  await page.getByRole('button', { name: 'Discard draft & reload' }).click();
  await page.getByText('Paused · revision 9', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'History & forfeited cards' }).click();
  await page.getByLabel('Outcome', { exact: true }).selectOption('lost');
  await page.getByLabel('Funding source', { exact: true }).selectOption('gift');
  await page.getByLabel('Customer ID', { exact: true }).fill('c&qa');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(historyRequests.at(-1).get('customer_id'), 'c&qa');
  assert.equal(historyRequests.at(-1).get('status'), 'lost');
  assert.equal(historyRequests.at(-1).get('source'), 'gift');
  await page.getByText('Details', { exact: true }).click();
  await page.getByText('900000', { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/admin-history.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: built admin route, paused state, zero/inheritance, published mismatch, draft persistence, audited revision save, 409 reload, history filters/detail, axe.',
  );
} finally {
  await browser.close();
  app.kill();
}
