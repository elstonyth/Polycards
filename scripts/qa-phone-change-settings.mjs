// Browser verification: the phone LOCK in account settings (spec
// docs/superpowers/specs/2026-10-06-real-name-and-phone-lock-design.md).
//
//   node scripts/qa-phone-change-settings.mjs [backend-port]
//
// Needs a storefront build with NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED=true
// and a backend with PHONE_VERIFICATION_REQUIRED=true (dev mode -> the OTP
// code is always '000000', per sendPhoneOtp's dev transport).
//
// Before the lock this script walked a Change -> new number -> OTP flow, and a
// flag-off mode checked an editable phone field. Both are gone: a verified
// number is customer service's to move (POST /admin/customers/:id/phone), and
// /store/customers/me refuses `phone` whatever the flag says.
//
// Flow: seed a customer with a VERIFIED phone (signup proof) and a real name
// via the backend API -> log in in the browser -> /settings shows the phone
// read-only, NO Change/Verify/Add button, and the "contact customer service"
// line -> the change route refuses the account backend-side -> a name-only
// save still works and leaves the phone alone.
//
// Screenshots to docs/research/.
import { chromium } from 'playwright';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

const BASE = 'http://localhost:4100';
const BACKEND = `http://localhost:${process.argv[2] || '9001'}`;
const PK =
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const EMAIL = `qa-phone-lock-${Date.now()}@test.dev`;
const PASSWORD = 'PhoneSettingsTest123!';
// Timestamp-suffixed: a fixed number collides with a prior run's row in the
// shared local DB (one phone = one account).
const SUFFIX = String(Date.now()).slice(-4);
const PHONE_E164 = `+6011222${SUFFIX}`;
const PHONE_NATIONAL = parsePhoneNumberFromString(PHONE_E164).formatNational();
const DEV_CODE = '000000';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
const json = (r) => r.json();
const storeHeaders = (token) => ({
  'Content-Type': 'application/json',
  'x-publishable-api-key': PK,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

// ── 0. Seed: verified phone + real name ──────────────────────────────────────
// checkPhoneOtpCode short-circuits to `code === devCode` in dev/test — no
// prior /start call is needed for the check to accept '000000'.
const { token: seedProof } = await fetch(
  `${BACKEND}/store/phone-verification/check`,
  {
    method: 'POST',
    headers: storeHeaders(),
    body: JSON.stringify({
      phone: PHONE_E164,
      purpose: 'signup',
      code: DEV_CODE,
    }),
  },
).then(json);
check(Boolean(seedProof), 'seed: phone OTP proof issued');

const reg = await fetch(`${BACKEND}/auth/customer/emailpass/register`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-phone-verification': seedProof,
  },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then(json);
const created = await fetch(`${BACKEND}/store/customers`, {
  method: 'POST',
  headers: { ...storeHeaders(reg.token), 'x-phone-verification': seedProof },
  body: JSON.stringify({ email: EMAIL, phone: PHONE_E164 }),
}).then(json);
check(
  created?.customer?.phone === PHONE_E164,
  'seed: customer created with the verified phone',
);
const { token: apiToken } = await fetch(`${BACKEND}/auth/customer/emailpass`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then(json);
// Without a real name the account pages are covered by the real-name gate.
const named = await fetch(`${BACKEND}/store/customers/me/real-name`, {
  method: 'POST',
  headers: storeHeaders(apiToken),
  body: JSON.stringify({ real_name: 'Qa Phone Lock' }),
});
check(named.ok, 'seed: real name on file');

// ── 1. Log in via the browser ────────────────────────────────────────────────
await page.goto(`${BASE}/?auth=login`, { waitUntil: 'load', timeout: 60000 });
await page.getByPlaceholder('Email').fill(EMAIL);
await page.getByPlaceholder('Password', { exact: true }).fill(PASSWORD);
await page.getByRole('button', { name: 'Log in', exact: true }).click();
const loggedIn = await page
  .getByRole('dialog', { name: 'Log in' })
  .waitFor({ state: 'detached', timeout: 30000 })
  .then(
    () => true,
    () => false,
  );
check(loggedIn, 'logs in with the seeded account');

// ── 2. /settings — the verified phone is locked ─────────────────────────────
await page.goto(`${BASE}/settings`, { waitUntil: 'load', timeout: 60000 });
const readonlyPhone = page.getByLabel('Phone (read-only)');
check(await readonlyPhone.isVisible(), 'read-only phone value is shown');
check(
  (await readonlyPhone.inputValue()) === PHONE_NATIONAL,
  `read-only value is the verified phone, national format (got "${await readonlyPhone.inputValue()}")`,
);
for (const name of ['Change', 'Verify', 'Add']) {
  check(
    (await page.getByRole('button', { name, exact: true }).count()) === 0,
    `no "${name}" button for a verified phone`,
  );
}
check(
  await page
    .getByText(/contact customer service/i)
    .first()
    .isVisible(),
  'the lock line points to customer service',
);
check(
  (await page.getByLabel('Real name (read-only)').inputValue()) ===
    'Qa Phone Lock',
  'the real name shows read-only',
);
await page.screenshot({ path: 'docs/research/qa-phone-lock-1-settings.png' });

// ── 3. Backend truth: the change route refuses the verified account ─────────
const refused = await fetch(`${BACKEND}/store/phone-verification/change`, {
  method: 'POST',
  headers: storeHeaders(apiToken),
  body: JSON.stringify({ phone: `+6011333${SUFFIX}`, token: 'x' }),
});
const refusedBody = await refused.json().catch(() => ({}));
check(
  refused.status === 400 && /customer service/i.test(refusedBody.message ?? ''),
  `change route refuses a verified account (got ${refused.status} "${refusedBody.message}")`,
);

// ── 4. A name-only save still works and leaves the phone alone ──────────────
await page.getByLabel('Username').fill(`qalock${SUFFIX}`);
await page.getByRole('button', { name: 'Save changes' }).click();
const saved = await page
  .getByText('Changes saved.')
  .waitFor({ state: 'visible', timeout: 15000 })
  .then(
    () => true,
    () => false,
  );
check(saved, 'name-only save still works');
check(
  (await page.getByLabel('Phone (read-only)').inputValue()) === PHONE_NATIONAL,
  'phone is unaffected by the name-only save',
);
await page.screenshot({ path: 'docs/research/qa-phone-lock-2-saved.png' });

await b.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
