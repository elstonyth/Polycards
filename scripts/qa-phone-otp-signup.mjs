// Task 6 browser verification: signup phone-OTP step, against a local build
// with NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED=true (storefront :4100) +
// PHONE_VERIFICATION_REQUIRED=true (backend, dev mode → OTP code is always
// '000000', logged by sendPhoneOtp's dev transport).
//
//   node scripts/qa-phone-otp-signup.mjs
//
// Flow: open signup → fill form → submit → confirm the OTP step renders
// (account NOT yet created) → wrong code shows inline error → correct code
// (000000) completes signup and closes the modal → phone shows on /settings.
// Screenshots to docs/research/.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4100';
const EMAIL = `qa-phone-otp-${Date.now()}@test.dev`;
const PASSWORD = 'PhoneOtpTest123!';
const NATIONAL_PHONE = '010-766 7787'; // default country MY → +60107667787
const E164_PHONE = '+60107667787';
const DEV_CODE = '000000';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

// ── 1. Fill the signup form ─────────────────────────────────────────────────
await page.goto(`${BASE}/?auth=signup`, { waitUntil: 'load', timeout: 60000 });
await page.getByPlaceholder('Username').fill('QA Phone OTP');
await page.getByPlaceholder('Email').fill(EMAIL);
await page.getByPlaceholder('Phone number').fill(NATIONAL_PHONE);
await page.getByPlaceholder('Password', { exact: true }).fill(PASSWORD);
await page.getByPlaceholder('Confirm password').fill(PASSWORD);
await page.getByRole('button', { name: 'Create account' }).click();

// ── 2. The OTP step renders — account is NOT created yet ───────────────────
const otpStepShown = await page
  .getByText('Verify your phone')
  .waitFor({ state: 'visible', timeout: 15000 })
  .then(
    () => true,
    () => false,
  );
check(
  otpStepShown,
  'signup submit opens the phone-OTP step (not immediate signup)',
);
check(
  await page.getByText(E164_PHONE).isVisible(),
  'OTP step shows the normalized E.164 phone',
);
// Still the "Create account" dialog (the sub-view swaps content, not the modal).
check(
  await page.getByRole('dialog', { name: 'Create account' }).isVisible(),
  'still inside the signup dialog',
);
await page.screenshot({ path: 'docs/research/qa-phone-otp-1-step.png' });

// ── 3. Wrong code → inline error, stays on the OTP step ─────────────────────
await page.getByPlaceholder('Verification code').fill('111111');
await page.getByRole('button', { name: 'Verify' }).click();
await page.waitForTimeout(1500);
check(
  await page.getByText('Invalid or expired code.').isVisible(),
  'wrong code shows the inline error',
);
await page.screenshot({ path: 'docs/research/qa-phone-otp-2-wrong-code.png' });

// ── 4. Correct dev code → signup completes, modal closes ────────────────────
await page.getByPlaceholder('Verification code').fill(DEV_CODE);
await page.getByRole('button', { name: 'Verify' }).click();
const signedUp = await page
  .getByRole('dialog', { name: 'Create account' })
  .waitFor({ state: 'detached', timeout: 30000 })
  .then(
    () => true,
    () => false,
  );
if (!signedUp) {
  console.log(
    '[debug] dialog text:',
    await page
      .getByRole('dialog', { name: 'Create account' })
      .innerText()
      .catch(() => '(gone)'),
  );
}
check(
  signedUp,
  'correct dev code (000000) completes signup and closes the modal',
);
await page.screenshot({ path: 'docs/research/qa-phone-otp-3-signed-up.png' });

// ── 5. The phone shows on /settings ──────────────────────────────────────────
// SettingsForm renders the number via PhoneField (country badge "+60" +
// national-format text "010-766 7787"), not the raw E.164 string.
await page.goto(`${BASE}/settings`, { waitUntil: 'load', timeout: 60000 });
const settingsPhoneValue = await page
  .getByRole('textbox', { name: 'Phone number' })
  .inputValue();
check(
  settingsPhoneValue === NATIONAL_PHONE,
  `/settings shows the verified phone (got "${settingsPhoneValue}")`,
);
await page.screenshot({ path: 'docs/research/qa-phone-otp-4-settings.png' });

await b.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
