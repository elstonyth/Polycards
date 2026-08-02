// Task 7 browser verification: forgot-password-by-phone flow, against a local
// build with NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED=true (storefront :4100) +
// PHONE_VERIFICATION_REQUIRED=true (backend, dev mode -> OTP code is always
// '000000', per sendPhoneOtp's dev transport).
//
//   node scripts/qa-phone-otp-forgot.mjs [backend-port]
//
// Seeds a customer with a VERIFIED phone directly via the backend API (the
// same register dance as scripts/qa-pack-open-charge.mjs, extended with the
// phone-OTP exchange src/lib/actions/auth.ts's signup() performs) rather than
// redoing the full signup-OTP UI dance scripts/qa-phone-otp-signup.mjs already
// covers.
//
// Flow: login modal -> Forgot password -> Use phone number instead -> enter
// the seeded phone -> dev code -> lands on /reset-password (masked email in
// the URL, never the real one) -> set a new password -> log in with it.
// Screenshots to docs/research/.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4100';
const BACKEND = `http://localhost:${process.argv[2] || '9001'}`;
const PK =
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const EMAIL = `qa-phone-forgot-${Date.now()}@test.dev`;
const OLD_PASSWORD = 'PhoneForgotOld123!';
const NEW_PASSWORD = 'PhoneForgotNew456!';
// A fixed number here collides with whatever the last run's seed customer
// left in the (persistent, shared) local DB — the phone-verification/
// password-reset route then sees 2 matches and (correctly) refuses with
// "More than one account uses this phone number." Vary the last 4 digits
// per run so this script stays re-runnable. Prefix matches the previously
// human-verified '010-766 7787'/'010-766 7789' numbers (default country MY).
const PHONE_SUFFIX = String(Date.now()).slice(-4);
const NATIONAL_PHONE = `010-766 ${PHONE_SUFFIX}`;
const E164_PHONE = `+6010766${PHONE_SUFFIX}`;
const DEV_CODE = '000000';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

// ── 0. Seed a customer with a VERIFIED phone via the backend API ───────────
// checkPhoneOtpCode short-circuits to `code === devCode` in dev/test (see
// backend/packages/api/src/utils/phone-verification.ts) — no prior /start
// call is needed for the check to accept '000000'.
const reg = await fetch(`${BACKEND}/auth/customer/emailpass/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: OLD_PASSWORD }),
}).then((r) => r.json());

const { token: seedProof } = await fetch(
  `${BACKEND}/store/phone-verification/check`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PK,
    },
    body: JSON.stringify({
      phone: E164_PHONE,
      purpose: 'signup',
      code: DEV_CODE,
    }),
  },
).then((r) => r.json());
check(Boolean(seedProof), 'seed: phone OTP proof issued');

// requireSignupPhoneProof (backend/.../utils/phone-verification-guard.ts)
// rejects a phone-bearing POST /store/customers without a valid
// x-phone-verification proof once PHONE_VERIFICATION_REQUIRED=true.
const created = await fetch(`${BACKEND}/store/customers`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-publishable-api-key': PK,
    Authorization: `Bearer ${reg.token}`,
    'x-phone-verification': seedProof,
  },
  body: JSON.stringify({ email: EMAIL, phone: E164_PHONE }),
}).then((r) => r.json());
check(
  created?.customer?.phone === E164_PHONE,
  'seed: customer created with the verified phone',
);

// ── 1. Forgot password → Use phone number instead ──────────────────────────
await page.goto(`${BASE}/?auth=login`, { waitUntil: 'load', timeout: 60000 });
await page.getByRole('button', { name: 'Forgot password?' }).click();
check(
  await page.getByText('Reset your password').isVisible(),
  'forgot view opens',
);
await page.getByRole('button', { name: 'Use phone number instead' }).click();
check(
  await page.getByPlaceholder('Phone number').isVisible(),
  '"Use phone number instead" opens the phone view',
);
check(
  await page.getByText("we'll text a code", { exact: false }).isVisible(),
  'unconditional "we\'ll text a code" copy is shown (no oracle)',
);
await page.screenshot({
  path: 'docs/research/qa-phone-forgot-1-phone-view.png',
});

// ── 2. Enter the seeded phone, submit → OTP step ────────────────────────────
await page.getByPlaceholder('Phone number').fill(NATIONAL_PHONE);
await page.getByRole('button', { name: 'Send code' }).click();
const otpStepShown = await page
  .getByText(E164_PHONE)
  .waitFor({ state: 'visible', timeout: 15000 })
  .then(
    () => true,
    () => false,
  );
check(otpStepShown, 'phone submit opens the OTP step');
await page.screenshot({ path: 'docs/research/qa-phone-forgot-2-otp-step.png' });

// ── 3. Correct dev code → redirect to /reset-password ───────────────────────
await page.getByPlaceholder('Verification code').fill(DEV_CODE);
await page.getByRole('button', { name: 'Verify' }).click();
const landed = await page
  .waitForURL(/\/reset-password\?/, { timeout: 20000 })
  .then(
    () => true,
    () => false,
  );
check(landed, 'verified code redirects to /reset-password');

const url = new URL(page.url());
const maskedEmailParam = url.searchParams.get('email');
const localPart = EMAIL.split('@')[0];
const expectedMasked = `${localPart[0]}${'*'.repeat(Math.max(localPart.length - 1, 2))}@test.dev`;
check(
  maskedEmailParam === expectedMasked,
  `redirect carries the MASKED email, never the real one (got "${maskedEmailParam}", expected "${expectedMasked}")`,
);
const pageHtml = await page.content();
check(
  !pageHtml.includes(EMAIL),
  'the real email never appears on the reset-password page',
);
await page.screenshot({
  path: 'docs/research/qa-phone-forgot-3-reset-page.png',
});

// ── 4. Set a new password ───────────────────────────────────────────────────
check(
  await page.getByText('Choose a new password').isVisible(),
  '/reset-password form renders',
);
await page.getByPlaceholder('New password', { exact: true }).fill(NEW_PASSWORD);
await page.getByPlaceholder('Confirm new password').fill(NEW_PASSWORD);
await page.getByRole('button', { name: 'Update password' }).click();
await page.waitForURL(/\/(\?.*)?$/, { timeout: 15000 });
await page.waitForTimeout(800);
check(
  await page.getByRole('dialog', { name: 'Log in' }).isVisible(),
  'success redirects to / with the login modal open',
);
await page.screenshot({
  path: 'docs/research/qa-phone-forgot-4-back-to-login.png',
});

// ── 5. Log in with the new password ─────────────────────────────────────────
await page.getByPlaceholder('Email').fill(EMAIL);
await page.getByPlaceholder('Password', { exact: true }).fill(NEW_PASSWORD);
await page.getByRole('button', { name: 'Log in', exact: true }).click();
const loggedIn = await page
  .getByRole('dialog', { name: 'Log in' })
  .waitFor({ state: 'detached', timeout: 30000 })
  .then(
    () => true,
    () => false,
  );
if (!loggedIn) {
  console.log(
    '[debug] login dialog text:',
    await page
      .getByRole('dialog', { name: 'Log in' })
      .innerText()
      .catch(() => '(gone)'),
  );
}
check(loggedIn, 'new password logs in (modal closes)');
await page.screenshot({
  path: 'docs/research/qa-phone-forgot-5-logged-in.png',
});

await b.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
