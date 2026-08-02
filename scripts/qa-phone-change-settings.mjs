// Task 8 browser verification: verified phone change from account settings.
//
//   node scripts/qa-phone-change-settings.mjs on [backend-port]
//   node scripts/qa-phone-change-settings.mjs off [backend-port]
//
// 'on' needs a storefront build with NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED
// =true + a backend with PHONE_VERIFICATION_REQUIRED=true (dev mode -> OTP
// code is always '000000', per sendPhoneOtp's dev transport). 'off' needs
// the OPPOSITE build (both flags unset/false) — the flag is build-time
// (NEXT_PUBLIC_*), so each mode requires its own `next build`; this script
// does not rebuild for you.
//
// 'on' flow: seed a customer with a verified phone via the backend API ->
// login in the browser -> /settings shows the phone READ-ONLY + a "Change"
// button (and NO editable phone textbox — that's the flag-on discriminator)
// -> Change -> enter a new number -> Send code -> wrong code shows inline
// error -> dev code verifies -> settings shows the NEW number, "Phone
// updated." note, GET /store/customers/me confirms it backend-side -> the
// name-save path (updateProfile, no phone in the body) still works
// alongside.
//
// 'off' flow: seed a customer with a phone via the backend API (no OTP
// dance — the write gate is off) -> login -> /settings shows an EDITABLE
// phone textbox seeded with that number (and NO "Change" button — the
// flag-off discriminator) -> editing name + phone together and saving still
// works exactly as before this task (updateProfile carries phone).
//
// Screenshots to docs/research/.
import { chromium } from 'playwright';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

const MODE = process.argv[2];
if (MODE !== 'on' && MODE !== 'off') {
  console.error(
    'Usage: node scripts/qa-phone-change-settings.mjs <on|off> [backend-port]',
  );
  process.exit(2);
}
const BASE = 'http://localhost:4100';
const BACKEND = `http://localhost:${process.argv[3] || '9001'}`;
const PK =
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const EMAIL = `qa-phone-settings-${MODE}-${Date.now()}@test.dev`;
const PASSWORD = 'PhoneSettingsTest123!';
// Timestamp-suffixed and distinct from each other, per Task 7's collision
// lesson (a fixed number collides with a prior run's row in the shared,
// persistent local DB and /store/customers/me listCustomers calls key off it
// in the backend's own uniqueness checks).
const SUFFIX = String(Date.now()).slice(-4);
const OLD_E164 = `+6011222${SUFFIX}`;
// Distinct from SUFFIX (different prefix, "333" vs "222") — no arithmetic
// needed to keep the two numbers apart.
const NEW_E164 = `+6011333${SUFFIX}`;
// Derive the expected national-format DISPLAY from the same library
// PhoneField itself uses, rather than guessing at libphonenumber's digit
// grouping — some MY prefixes format with dashes ("010-766 1234"), others
// render as a flat digit run ("112221234"); hand-typing either would be
// right by luck, not by construction.
const OLD_NATIONAL = parsePhoneNumberFromString(OLD_E164).formatNational();
const NEW_NATIONAL = parsePhoneNumberFromString(NEW_E164).formatNational();
const DEV_CODE = '000000';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

// ── 0. Seed a customer via the backend API ──────────────────────────────────
const reg = await fetch(`${BACKEND}/auth/customer/emailpass/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then((r) => r.json());

let created;
if (MODE === 'on') {
  // checkPhoneOtpCode short-circuits to `code === devCode` in dev/test (see
  // backend/packages/api/src/utils/phone-verification.ts) — no prior /start
  // call is needed for the check to accept '000000'.
  const { token: seedProof } = await fetch(
    `${BACKEND}/store/phone-verification/check`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': PK,
      },
      body: JSON.stringify({
        phone: OLD_E164,
        purpose: 'signup',
        code: DEV_CODE,
      }),
    },
  ).then((r) => r.json());
  check(Boolean(seedProof), 'seed: phone OTP proof issued');

  created = await fetch(`${BACKEND}/store/customers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PK,
      Authorization: `Bearer ${reg.token}`,
      'x-phone-verification': seedProof,
    },
    body: JSON.stringify({ email: EMAIL, phone: OLD_E164 }),
  }).then((r) => r.json());
} else {
  // Flag off (backend gate not active) — a plain phone write needs no proof.
  created = await fetch(`${BACKEND}/store/customers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PK,
      Authorization: `Bearer ${reg.token}`,
    },
    body: JSON.stringify({ email: EMAIL, phone: OLD_E164 }),
  }).then((r) => r.json());
}
check(
  created?.customer?.phone === OLD_E164,
  'seed: customer created with the seeded phone',
);

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

// The register token's actor_id is empty until POST /store/customers links
// it (per-session precedent: "Medusa register token has empty actor_id") —
// use the FRESH JWT the browser just got from logging in for any
// /store/customers/me truth-check, not the original registration token.
const jwt = (await page.context().cookies()).find(
  (c) => c.name === '_polycards_jwt',
)?.value;
check(Boolean(jwt), 'browser session cookie (_polycards_jwt) is set');
const authedGetMe = () =>
  fetch(`${BACKEND}/store/customers/me`, {
    headers: { 'x-publishable-api-key': PK, Authorization: `Bearer ${jwt}` },
  }).then((r) => r.json());

// ── 2. /settings — mode-specific discriminating assertions ─────────────────
await page.goto(`${BASE}/settings`, { waitUntil: 'load', timeout: 60000 });

if (MODE === 'off') {
  // Flag-off build must render exactly today's editable form: a real
  // textbox seeded with the phone, and NO "Change" affordance anywhere (a
  // script that only checks the happy path can go green even if the
  // flag-off branch quietly regressed to the enforcement UI).
  const phoneBox = page.getByRole('textbox', { name: 'Phone number' });
  check(
    await phoneBox.isVisible(),
    'flag-off: editable phone textbox is present',
  );
  check(
    (await phoneBox.inputValue()) === OLD_NATIONAL,
    `flag-off: phone textbox is seeded with the customer's number (got "${await phoneBox.inputValue()}")`,
  );
  check(
    (await page
      .getByRole('button', { name: 'Change', exact: true })
      .count()) === 0,
    'flag-off: no "Change" button is rendered',
  );
  await page.screenshot({
    path: 'docs/research/qa-phone-settings-off-1-editable-form.png',
  });

  // Regression: name + phone still save together through updateProfile.
  await page.getByLabel('Display name').fill('QA Off Mode');
  await phoneBox.fill(NEW_NATIONAL);
  await page.getByRole('button', { name: 'Save changes' }).click();
  const saved = await page
    .getByText('Changes saved.')
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  check(saved, 'flag-off: profile save (name + phone) still works');
  await page.screenshot({
    path: 'docs/research/qa-phone-settings-off-2-saved.png',
  });

  const me = await authedGetMe();
  check(
    me?.customer?.phone === NEW_E164,
    `flag-off: GET /store/customers/me reflects the new phone (got "${me?.customer?.phone}")`,
  );

  await b.close();
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

// MODE === 'on' ───────────────────────────────────────────────────────────
check(
  (await page.getByRole('textbox', { name: 'Phone number' }).count()) === 0,
  'flag-on: no EDITABLE phone textbox is rendered',
);
const readonlyPhone = page.getByLabel('Phone (read-only)');
check(
  await readonlyPhone.isVisible(),
  'flag-on: read-only phone value is shown',
);
check(
  (await readonlyPhone.inputValue()) === OLD_NATIONAL,
  // National format, matching what the flag-off editable PhoneField shows —
  // not raw E.164 (an earlier version of this script asserted E.164 and so
  // couldn't have caught a formatting regression either way).
  `flag-on: read-only value matches the seeded phone, national format (got "${await readonlyPhone.inputValue()}")`,
);
const changeButton = page.getByRole('button', { name: 'Change', exact: true });
check(await changeButton.isVisible(), 'flag-on: "Change" button is present');
await page.screenshot({
  path: 'docs/research/qa-phone-settings-1-readonly.png',
});

// ── 3. Change → entry step ──────────────────────────────────────────────────
await changeButton.click();
const newPhoneBox = page.getByPlaceholder('New phone number');
check(await newPhoneBox.isVisible(), 'entry step: new-number PhoneField shown');
await page.screenshot({ path: 'docs/research/qa-phone-settings-2-entry.png' });

// ── 4. Send code → OTP step ─────────────────────────────────────────────────
await newPhoneBox.fill(NEW_NATIONAL);
await page.getByRole('button', { name: 'Send code' }).click();
const otpShown = await page
  .getByText(NEW_E164)
  .waitFor({ state: 'visible', timeout: 15000 })
  .then(
    () => true,
    () => false,
  );
check(otpShown, 'Send code opens the OTP step, showing the new E.164 number');
// Discriminates "the entry step's Send code button is a REAL button" from
// the nested-<form> failure mode that would let it accidentally submit the
// OUTER profile form instead (which would show "Changes saved.", not the
// OTP step, and/or throw a nested-form console error).
check(
  (await page.getByText('Changes saved.').count()) === 0,
  'Send code did NOT also submit the outer profile form',
);

// ── 5. Wrong code → inline error, stays on the OTP step ─────────────────────
await page.getByPlaceholder('Verification code').fill('111111');
await page.getByRole('button', { name: 'Verify' }).click();
await page.waitForTimeout(1500);
check(
  await page.getByText('Invalid or expired code.').isVisible(),
  'wrong code shows the inline error',
);
await page.screenshot({
  path: 'docs/research/qa-phone-settings-3-wrong-code.png',
});

// ── 6. Correct dev code → phone updates ─────────────────────────────────────
await page.getByPlaceholder('Verification code').fill(DEV_CODE);
await page.getByRole('button', { name: 'Verify' }).click();
const updated = await page
  .getByText('Phone updated.')
  .waitFor({ state: 'visible', timeout: 20000 })
  .then(
    () => true,
    () => false,
  );
check(updated, 'correct dev code updates the phone ("Phone updated." note)');
const readonlyAfter = page.getByLabel('Phone (read-only)');
check(
  (await readonlyAfter.inputValue()) === NEW_NATIONAL,
  `settings displays the NEW phone, national format (got "${await readonlyAfter.inputValue()}")`,
);
await page.screenshot({
  path: 'docs/research/qa-phone-settings-4-updated.png',
});

// ── 7. Backend truth check ───────────────────────────────────────────────────
const me = await authedGetMe();
check(
  me?.customer?.phone === NEW_E164,
  `GET /store/customers/me shows the new phone (got "${me?.customer?.phone}")`,
);

// ── 8. Profile save (names) still works alongside ───────────────────────────
await page.getByLabel('Display name').fill('QA Phone Settings');
await page.getByRole('button', { name: 'Save changes' }).click();
const namesSaved = await page
  .getByText('Changes saved.')
  .waitFor({ state: 'visible', timeout: 15000 })
  .then(
    () => true,
    () => false,
  );
check(namesSaved, 'name save (no phone in the body) still works alongside');
// The updated phone must survive a name-only save (Step 1's regression: the
// backend gate 400s the WHOLE request if `phone` rides along under
// enforcement — this would only surface here, not in the change flow itself).
check(
  (await page.getByLabel('Phone (read-only)').inputValue()) === NEW_NATIONAL,
  'phone is unaffected by the name-only save',
);
await page.screenshot({
  path: 'docs/research/qa-phone-settings-5-name-save.png',
});

// A blanket "zero console errors" check false-positives on this flow: the
// deliberate wrong-code check (step 5) provokes a real 400 from
// /store/phone-verification/check, which Chromium logs as a "Failed to load
// resource" console error even though the app handles it correctly (inline
// "Invalid or expired code."). Target the specific failure mode the entry
// step's <form>->plain-<div> conversion (and the OTP step's early-return,
// out of the profile <form>) was meant to prevent: React's DOM-nesting
// warning for a <form> inside a <form>.
const nestingErrors = consoleErrors.filter((e) =>
  /validateDOMNesting|<form> cannot appear/i.test(e),
);
check(
  nestingErrors.length === 0,
  `zero <form>-nesting console errors (got ${nestingErrors.length})`,
);
if (consoleErrors.length)
  console.log(
    '[debug] all console errors (includes expected 400s):',
    consoleErrors,
  );

await b.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
