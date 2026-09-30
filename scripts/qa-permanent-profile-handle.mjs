// QA: the profile link is a permanent handle; a rename changes the name only
// (2026-09-30 — /profile/Collector6167, posted to the Telegram board for an
// Immortal pull, 404'd the day after because its owner renamed).
//
//   node scripts/qa-permanent-profile-handle.mjs [backend-port]
//
// Needs the prod build on :4000 (scripts/serve-standalone.ps1) and a backend.
// Seeds a fresh account through the backend API with a typed username, logs in
// in the browser (the login's GET /store/profiles/me freezes the handle),
// renames it on /settings, then checks that the old link still resolves to the
// same player under the new name and that the new name is not a second URL.
// Screenshots to docs/research/.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const BACKEND = `http://localhost:${process.argv[2] || '9000'}`;
const PK =
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const RUN = String(Date.now()).slice(-6);
const EMAIL = `qa-handle-${RUN}@test.dev`;
const PASSWORD = 'HandleTest123!';
const FIRST = `QaFirst${RUN}`;
const RENAMED = `QaRenamed${RUN}`;
const PHONE = `+60114${RUN}`;

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
const json = {
  'Content-Type': 'application/json',
  'x-publishable-api-key': PK,
};

// ── 0. Seed the account with a typed username ──────────────────────────────
const reg = await fetch(`${BACKEND}/auth/customer/emailpass/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then((r) => r.json());
// Dev OTP transport accepts '000000'; harmless when the phone gate is off.
const proof = await fetch(`${BACKEND}/store/phone-verification/check`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ phone: PHONE, purpose: 'signup', code: '000000' }),
})
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));
const created = await fetch(`${BACKEND}/store/customers`, {
  method: 'POST',
  headers: {
    ...json,
    Authorization: `Bearer ${reg.token}`,
    ...(proof.token ? { 'x-phone-verification': proof.token } : {}),
  },
  body: JSON.stringify({ email: EMAIL, first_name: FIRST, phone: PHONE }),
}).then((r) => r.json());
check(created?.customer?.first_name === FIRST, `seed: signed up as ${FIRST}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

// ── 1. Log in — freezes the handle from the registration name ─────────────
await page.goto(`${BASE}/?auth=login`, { waitUntil: 'load', timeout: 60000 });
await page.getByPlaceholder('Email').fill(EMAIL);
await page.getByPlaceholder('Password', { exact: true }).fill(PASSWORD);
await page.getByRole('button', { name: 'Log in', exact: true }).click();
check(
  await page
    .getByRole('dialog', { name: 'Log in' })
    .waitFor({ state: 'detached', timeout: 30000 })
    .then(
      () => true,
      () => false,
    ),
  'logs in',
);

const chipText = async () =>
  (await page.getByRole('button', { name: /Copy handle/ }).textContent()) ?? '';

await page.goto(`${BASE}/me`, { waitUntil: 'load', timeout: 60000 });
check((await chipText()).includes(`@${FIRST}`), `/me chip reads @${FIRST}`);

// ── 2. Rename on /settings ─────────────────────────────────────────────────
await page.goto(`${BASE}/settings`, { waitUntil: 'load', timeout: 60000 });
const username = page.getByRole('textbox', { name: 'Username' });
// A plain string, not `text=/…/` — that selector form parses as a regex.
check(
  (await page.getByText(`/profile/${FIRST}`).count()) > 0,
  'settings hint shows the permanent link',
);
await username.fill(RENAMED);
await page.getByRole('button', { name: 'Save changes' }).click();
check(
  await page
    .getByText('Changes saved.')
    .waitFor({ timeout: 20000 })
    .then(
      () => true,
      () => false,
    ),
  `renamed to ${RENAMED}`,
);
// Frame the username field and its hint, clear of the sticky header.
await username.scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, -140));
await page.screenshot({ path: 'docs/research/qa-handle-settings.png' });

// ── 3. /me: new name, same handle ──────────────────────────────────────────
await page.goto(`${BASE}/me`, { waitUntil: 'load', timeout: 60000 });
check(
  ((await page.locator('h1').first().textContent()) ?? '').includes(RENAMED),
  '/me shows the new name',
);
check(
  (await chipText()).includes(`@${FIRST}`),
  `/me chip still reads @${FIRST}`,
);
await page.screenshot({ path: 'docs/research/qa-handle-me.png' });

// ── 4. The old link still resolves, to the same player, under the new name ─
const old = await page.goto(`${BASE}/profile/${FIRST}`, {
  waitUntil: 'load',
  timeout: 60000,
});
check(old?.status() === 200, `/profile/${FIRST} → 200`);
check(
  ((await page.locator('h1').first().textContent()) ?? '').includes(RENAMED),
  `/profile/${FIRST} shows ${RENAMED}`,
);
check(
  (await page.getByText(`@${FIRST}`).count()) > 0,
  `/profile/${FIRST} shows @${FIRST}`,
);
await page.waitForTimeout(1500); // let the header's fade-in finish
await page.screenshot({ path: 'docs/research/qa-handle-profile.png' });

// ── 5. One profile, one URL ────────────────────────────────────────────────
const second = await page.goto(`${BASE}/profile/${RENAMED}`, {
  waitUntil: 'load',
  timeout: 60000,
});
check(second?.status() === 404, `/profile/${RENAMED} → 404`);

// ── 6. Backend truth ───────────────────────────────────────────────────────
const jwt = (await page.context().cookies()).find(
  (c) => c.name === '_polycards_jwt',
)?.value;
const me = await fetch(`${BACKEND}/store/profiles/me`, {
  headers: { ...json, Authorization: `Bearer ${jwt}` },
}).then((r) => r.json());
check(me.handle === FIRST, `GET /store/profiles/me → ${me.handle}`);

await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
