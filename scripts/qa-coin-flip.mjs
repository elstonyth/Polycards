// Local standalone UI contract test. Real settlement is covered by PostgreSQL/HTTP tests.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const out = path.resolve('.superpowers/sdd/2026-10-28-vault-coin-flip/qa');
await mkdir(out, { recursive: true });
let outcome = 'won';
let failResponse = false;
let accepts = 0;
let sequence = 0;
const rounds = new Map();
const unknown = new Set();
const card = {
  pull_id: 'pull_qa',
  name: 'Pikachu · PSA 10',
  image: '/images/app/polycards-card-back.webp',
  grader: 'PSA',
  grade: '10',
};
const settings = {
  enabled: true,
  eligible: true,
  reason: null,
  published_win_percent: 50,
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:9000');
  const p = url.pathname;
  let body = {};
  let status = 200;
  if (p === '/store/customers/me')
    body = {
      customer: {
        id: 'customer_qa',
        email: 'qa@example.test',
        first_name: 'Collector',
        phone: '+60123456789',
        metadata: {},
        addresses: [],
      },
    };
  else if (p.endsWith('/real-name')) body = { real_name: 'QA Collector' };
  else if (p.endsWith('/account'))
    body = { hasPassword: true, phoneVerified: true, realName: 'QA Collector' };
  else if (p === '/store/vault')
    body = {
      items: [
        {
          pull_id: card.pull_id,
          rolled_at: new Date().toISOString(),
          source: 'gift',
          locked: false,
          sellable: true,
          card: {
            handle: 'pikachu',
            name: card.name,
            image: card.image,
            marketPriceMyr: 100,
          },
          buyback: { amount: 90, percent: 90, firm: true, bonus: 90 },
        },
      ],
    };
  else if (p === '/store/coin-flips/settings') body = settings;
  else if (p === '/store/coin-flips/quotes') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const selection = JSON.parse(raw);
    assert.deepEqual(selection.pull_ids, [card.pull_id]);
    const round = {
      id: `cfr_qa${++sequence}`,
      status: 'quoted',
      stake_amount: 100,
      win_amount: 0,
      published_win_percent: 50,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      settled_at: null,
      card,
      cards: [{ ...card, stake_amount: 100 }],
      chosen_side: selection.chosen_side,
      landed_side: null,
    };
    rounds.set(round.id, round);
    body = { round };
  } else if (p.startsWith('/store/coin-flips/')) {
    const id = p.split('/')[3];
    const round = rounds.get(id);
    if (!round) {
      status = 404;
      body = { message: 'Coin flip not found.' };
    } else {
      if (p.endsWith('/accept')) {
        accepts++;
        if (round.status === 'quoted')
          Object.assign(round, {
            status: outcome,
            win_amount: outcome === 'won' ? 100 : 0,
            settled_at: new Date().toISOString(),
            landed_side:
              outcome === 'won'
                ? round.chosen_side
                : round.chosen_side === 'head'
                  ? 'tail'
                  : 'head',
          });
        if (failResponse) {
          failResponse = false;
          status = 500;
        }
      }
      body =
        status === 500
          ? { message: 'Simulated response interruption' }
          : { round };
    }
  } else if (p === '/store/coin-flips') {
    const values = [...rounds.values()]
      .filter((r) => r.status !== 'quoted')
      .reverse();
    body = {
      rounds: values,
      count: values.length,
      limit: 10,
      offset: 0,
      totals: {
        head: values.filter((r) => r.landed_side === 'head').length,
        tail: values.filter((r) => r.landed_side === 'tail').length,
      },
    };
  } else if (p.endsWith('/latest')) body = { latest_event_at: null };
  else if (p.startsWith('/store/credits'))
    body = {
      balance: 100,
      topup_total: 100,
      spend_total: 100,
      transactions: [],
      wallet: {
        balance: 100,
        available: 100,
        withdrawable: 100,
        is_frozen: false,
        has_topup: true,
        playthrough: { deposited: 100, used: 100, remaining: 0 },
      },
    };
  else if (p === '/store/free-pack') body = { eligible: false, slug: null };
  else if (p.includes('announcement'))
    body = { announcements: [], announcement: null };
  else if (p === '/store/pack-gifts') body = { gifts: [] };
  else if (p.includes('/packs')) body = { packs: [], count: 0 };
  else if (p.includes('/pulls')) body = { pulls: [] };
  else {
    unknown.add(p);
    body = {};
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(9000, '127.0.0.1', resolve);
});
for (const [target, location] of [
  ['public', '.next/standalone/public'],
  ['.next/static', '.next/standalone/.next/static'],
]) {
  await cp(path.resolve(target), path.resolve(location), { recursive: true });
}
const app = spawn(process.execPath, ['.next/standalone/server.js'], {
  env: {
    ...process.env,
    PORT: '4020',
    HOSTNAME: '127.0.0.1',
    // The default localhost:9000 can resolve to ::1, where a real local backend may listen.
    NEXT_PUBLIC_MEDUSA_BACKEND_URL: 'http://127.0.0.1:9000',
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
app.stdout.on('data', (b) => {
  logs += b;
});
app.stderr.on('data', (b) => {
  logs += b;
});
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader'],
});
const errors = [];
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      await fetch('http://127.0.0.1:4020/healthz');
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert(ready, 'Standalone server ready');
  async function context(options = {}) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      ...options,
    });
    await ctx.addCookies([
      {
        name: '_polycards_jwt',
        value: 'qa-only',
        url: 'http://127.0.0.1:4020',
        httpOnly: true,
      },
    ]);
    await ctx.addInitScript(() => {
      localStorage.setItem('polycards.cookie-consent', 'rejected');
      localStorage.setItem('polycards.slot.muted', '1');
    });
    return ctx;
  }
  const ctx = await context();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:4020/vault/coin-flip?pull=pull_qa');
  await page.getByRole('button', { name: 'Review cards' }).waitFor();
  await page.locator('canvas').waitFor();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${out}/desktop-ready.png`, fullPage: true });
  const a11y = await new AxeBuilder({ page }).include('#main').analyze();
  assert.deepEqual(
    a11y.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target).join(',')}`,
    ),
    [],
    'Coin page accessibility',
  );
  async function arm(p) {
    if (
      !(await p
        .getByRole('dialog', { name: 'Choose from your Vault' })
        .isVisible())
    ) {
      const change = p.getByRole('button', {
        name: 'Edit selection',
        exact: true,
      });
      const choose = p.getByRole('button', { name: /Choose from Vault/ });
      // A fresh page paints neither until it has loaded.
      await change.or(choose).first().waitFor();
      if (await change.isVisible()) await change.click();
      else await choose.click();
    }
    const cardButton = p.getByRole('button', {
      name: 'Select Pikachu · PSA 10, RM 100.00',
      exact: true,
    });
    if ((await cardButton.getAttribute('aria-pressed')) !== 'true')
      await cardButton.click();
    await p.getByRole('button', { name: 'Use 1 card', exact: true }).click();
    await p.getByRole('button', { name: 'Review cards' }).click();
    await p.getByRole('dialog').waitFor();
    await p
      .getByRole('button', { name: 'Confirm card · Head', exact: true })
      .click();
  }
  await arm(page);
  assert.equal(accepts, 0);
  await page.getByRole('button', { name: 'Flip coin', exact: true }).click();
  await page.getByText('Coin in flight…', { exact: true }).waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/desktop-flight.png`, fullPage: false });
  await page
    .getByRole('heading', { name: '+RM 100.00', exact: true })
    .waitFor();
  assert.equal(accepts, 1);
  await page.screenshot({ path: `${out}/desktop-win.png`, fullPage: true });
  await page.getByRole('button', { name: 'Choose cards' }).click();
  assert.equal(
    await page
      .getByRole('dialog', { name: 'Choose from your Vault' })
      .isVisible(),
    true,
  );
  assert.equal(await page.locator('select').count(), 0);
  outcome = 'lost';
  await arm(page);
  // Use real hit testing and pointer input, including drag + upward release.
  const canvas = await page.locator('canvas').boundingBox();
  assert(canvas);
  await page.mouse.move(
    canvas.x + canvas.width / 2,
    canvas.y + canvas.height * 0.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvas.x + canvas.width / 2 + 15,
    canvas.y + canvas.height * 0.5 - 85,
    { steps: 4 },
  );
  // A PC user may pause while holding the coin; release must still toss it.
  await page.waitForTimeout(1000);
  await page.mouse.up();
  await page
    .getByRole('heading', { name: 'Card forfeited', exact: true })
    .waitFor({ timeout: 10000 });
  assert.equal(accepts, 2);
  await page.screenshot({ path: `${out}/desktop-loss.png`, fullPage: true });
  await page.getByRole('button', { name: 'Choose cards' }).click();
  outcome = 'won';
  failResponse = true;
  await arm(page);
  await page.getByRole('button', { name: 'Flip coin', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Resolve your previous flip' })
    .waitFor();
  await page.reload();
  await page
    .getByRole('heading', { name: '+RM 100.00', exact: true })
    .waitFor();
  assert.equal(accepts, 3);
  const mobile = await context({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    isMobile: true,
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.goto('http://127.0.0.1:4020/vault/coin-flip?pull=pull_qa');
  await arm(phone);
  await phone.screenshot({ path: `${out}/phone-armed.png`, fullPage: true });
  await phone.getByRole('button', { name: 'Flip coin', exact: true }).focus();
  await phone.keyboard.press('Enter');
  await phone
    .getByRole('heading', { name: '+RM 100.00', exact: true })
    .waitFor();
  assert.equal(
    await phone.locator('canvas').count(),
    0,
    'Reduced motion skips WebGL',
  );
  assert(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'No phone horizontal overflow',
  );
  await phone.screenshot({ path: `${out}/phone-win.png`, fullPage: true });
  const touchContext = await context({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const touchPhone = await touchContext.newPage();
  touchPhone.on('pageerror', (e) => errors.push(e.message));
  await touchPhone.goto('http://127.0.0.1:4020/vault/coin-flip?pull=pull_qa');
  await arm(touchPhone);
  await touchPhone.locator('canvas').waitFor();
  await touchPhone.waitForTimeout(1000);
  await touchPhone.locator('canvas').scrollIntoViewIfNeeded();
  const touchCanvas = await touchPhone.locator('canvas').boundingBox();
  assert(touchCanvas);
  const touch = await touchContext.newCDPSession(touchPhone);
  const x = touchCanvas.x + touchCanvas.width / 2;
  const y = touchCanvas.y + touchCanvas.height / 2;
  const beforeTouch = accepts;
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  for (const distance of [20, 45, 85]) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + 8, y: y - distance }],
    });
  }
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await touchPhone
    .getByRole('heading', { name: '+RM 100.00', exact: true })
    .waitFor();
  assert.equal(
    accepts,
    beforeTouch + 1,
    'One touch flick settles exactly once',
  );
  await touchPhone.screenshot({
    path: `${out}/phone-touch-win.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Choose cards' }).click();
  await arm(page);
  await page.evaluate(() =>
    document
      .querySelector('canvas')
      ?.getContext('webgl2')
      ?.getExtension('WEBGL_lose_context')
      ?.loseContext(),
  );
  await page.getByRole('button', { name: 'Flip coin', exact: true }).click();
  await page
    .getByRole('heading', { name: '+RM 100.00', exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    `PASS: desktop tap/flick, mobile touch flick, win/loss, response-loss reload recovery, reduced-motion keyboard, WebGL-loss fallback, axe, phone overflow; ${accepts} explicit commits.`,
  );
  console.log('Optional shell requests:', [...unknown].join(', '));
} finally {
  await writeFile(`${out}/standalone.log`, logs);
  await browser.close();
  app.kill();
  server.close();
}
