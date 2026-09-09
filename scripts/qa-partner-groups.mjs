// One-off QA: partner groups (spec 2026-09-09). Seeds a throwaway customer and
// a partner group through the API, then screenshots every surface the feature
// touches. Run from the repo root so @playwright/test resolves:
//   node scripts/qa-partner-groups.mjs
// Reads admin creds from the gitignored scripts/.dev-logins (never printed) and
// the publishable key from .env.local. Env: QA_OUT (screenshot dir),
// QA_BACKEND (:9000), QA_ADMIN (:7000/dashboard), QA_STOREFRONT (:4100).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = process.env.QA_OUT ?? path.join(ROOT, 'docs/research');
const BACKEND = process.env.QA_BACKEND ?? 'http://127.0.0.1:9000';
const ADMIN = process.env.QA_ADMIN ?? 'http://localhost:7000/dashboard';
const STOREFRONT = process.env.QA_STOREFRONT ?? 'http://127.0.0.1:4100';
const LOGINS = process.env.QA_LOGINS ?? path.join(ROOT, 'scripts/.dev-logins');

const kv = (file) =>
  Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [
          l.slice(0, i).trim(),
          l
            .slice(i + 1)
            .trim()
            .replace(/^"|"$/g, ''),
        ];
      }),
  );
const creds = kv(LOGINS);
const env = kv(path.join(ROOT, '.env.local'));
const PK = env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY;
if (!PK)
  throw new Error('NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY missing in .env.local');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, { method = 'GET', body, token, headers = {} } = {}) {
  const h = {
    'Content-Type': 'application/json',
    'x-publishable-api-key': PK,
    ...headers,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${BACKEND}${p}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : {};
    if (res.status === 429 && attempt < 5) {
      const secs = Number(text.match(/again in (\d+)s/)?.[1] ?? '8');
      await sleep((secs + 1) * 1000);
      continue;
    }
    const err = new Error(`${method} ${p} -> ${res.status} ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
}

// ── Seed ───────────────────────────────────────────────────────────────────
const stamp = Date.now().toString(36);
const adminTok = (
  await api('/auth/user/emailpass', {
    method: 'POST',
    body: { email: creds.ADMIN_EMAIL, password: creds.ADMIN_PW },
  })
).token;
const A = { token: adminTok };

const name = `qa-partner-${stamp}`;
const email = `${name}@polycards.local`;
const password = 'PwQa2026!';
const reg = await api('/auth/customer/emailpass/register', {
  method: 'POST',
  body: { email, password },
});
const created = await api('/store/customers', {
  method: 'POST',
  token: reg.token,
  body: { email, first_name: name },
});
const customerId = created.customer.id;
const custTok = (
  await api('/auth/customer/emailpass', {
    method: 'POST',
    body: { email, password },
  })
).token;
console.log('customer', customerId, email);

const groupName = `Partners QA ${stamp}`;
const group = (
  await api('/admin/customer-groups', {
    method: 'POST',
    token: A.token,
    body: { name: groupName, metadata: { odds_set: 2 } },
  })
).customer_group;
console.log('group', group.id, groupName);
await api(`/admin/customers/${customerId}/group`, {
  method: 'POST',
  token: A.token,
  body: { group_id: group.id },
});
const policy = await api(`/admin/customer-groups/${group.id}/policy`, {
  method: 'POST',
  token: A.token,
  body: {
    partner_rate_bp: 400,
    withdrawals_blocked: true,
    verification_exempt: true,
    reason: 'QA screenshot seed',
  },
});
console.log('policy metadata', JSON.stringify(policy.customer_group.metadata));

// The conflict rule, from the API: manual rate refused while in the group.
try {
  await api(`/admin/customers/${customerId}/partner-rate`, {
    method: 'POST',
    token: A.token,
    body: { rate_bp: 350, reason: 'QA should be refused' },
  });
  console.log('partner-rate: UNEXPECTEDLY ACCEPTED');
} catch (e) {
  console.log('partner-rate refused:', e.status, JSON.parse(e.body).message);
}
// The withdraw block, from the API.
try {
  await api('/store/credits/withdraw', {
    method: 'POST',
    token: custTok,
    body: { amount: 10, account_id: 'acct_none' },
  });
  console.log('withdraw: UNEXPECTEDLY ACCEPTED');
} catch (e) {
  console.log('withdraw refused:', e.status, JSON.parse(e.body).message);
}
const account = await api('/store/customers/me/account', { token: custTok });
console.log('account policy', JSON.stringify(account.policy));
const players = await api(`/admin/players?q=${encodeURIComponent(email)}`, {
  token: A.token,
});
console.log(
  'players row partner =',
  players.players.find((p) => p.id === customerId)?.partner,
);

// ── Screenshots ─────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const shot = async (n, opts = {}) => {
  await page.waitForTimeout(600);
  const file = path.join(OUT, `qa-partner-${n}.png`);
  await page.screenshot({ path: file, ...opts });
  console.log('shot', file);
};

// Admin login (rate-limited endpoint — retry through the window).
for (let attempt = 0; attempt < 4; attempt++) {
  await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', creds.ADMIN_EMAIL);
  await page.fill('input[name="password"]', creds.ADMIN_PW);
  await page.press('input[name="password"]', 'Enter');
  try {
    await page.waitForURL((u) => !u.pathname.endsWith('/login'), {
      timeout: 15000,
    });
    break;
  } catch {
    await sleep(8000);
  }
}

// 1. Player Groups page — the seeded row with its partner policy.
await page.goto(`${ADMIN}/odds-sets`, { waitUntil: 'domcontentloaded' });
await page.getByText(groupName).waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
await shot('1-player-groups');

// 2. Players list — the purple Partner badge on the seeded player.
await page.goto(`${ADMIN}/players`, { waitUntil: 'domcontentloaded' });
await page.getByPlaceholder('Search name, email or phone').fill(email);
await page.getByText(email).first().waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
await shot('2-players-badge');

// 3. Customer detail — header badge + locked Referral card.
await page.goto(`${ADMIN}/customers/${customerId}`, {
  waitUntil: 'domcontentloaded',
});
await page.getByText('Partner rate').waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
await shot('3-customer-detail', { fullPage: true });

// 4. The prebuilt Edit Customer Group rename — the bug the strip fixes.
await page.goto(`${ADMIN}/customer-groups/${group.id}/edit`, {
  waitUntil: 'domcontentloaded',
});
const nameInput = page.locator('input[name="name"]');
await nameInput.waitFor({ timeout: 60000 });
await nameInput.fill(`${groupName} renamed`);
await page.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(1500);
await shot('4-group-rename');
const renamed = (
  await api(`/admin/customer-groups/${group.id}`, { token: A.token })
).customer_group.name;
console.log('renamed to', renamed);

// 5. Storefront bank-withdrawal notice for the blocked member.
await page.context().addCookies([
  {
    name: '_polycards_jwt',
    value: custTok,
    url: STOREFRONT,
    httpOnly: true,
    sameSite: 'Lax',
  },
]);
await page.goto(`${STOREFRONT}/bank-withdrawal`, {
  waitUntil: 'domcontentloaded',
});
await page
  .getByText('Withdrawals are not available on this account')
  .waitFor({ timeout: 60000 });
await shot('5-storefront-withdraw-blocked');

// 6. Storefront referral page shows the partner rate.
await page.goto(`${STOREFRONT}/referral`, { waitUntil: 'domcontentloaded' });
await page.getByText('Partner rate').waitFor({ timeout: 60000 });
await page.waitForTimeout(800);
await shot('6-storefront-referral');

await browser.close();
console.log('done');
