// qa-phone-otp-turnstile.mjs — the Turnstile human check on OTP sends.
// Usage: node scripts/qa-phone-otp-turnstile.mjs [baseUrl] [outDir]
//
// Runs against a LOCAL prod build (scripts/serve-standalone.ps1) made with
// Cloudflare's TEST keys, never real ones:
//   storefront build: NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
//                     (always passes; 3x00000000000000000000FF forces the
//                     interactive checkbox — set PW_INTERACTIVE=1 for that)
//                     NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED=true CSP_ENFORCE=true
//   backend:          TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
// The backend's dev transport logs the code instead of texting, so nothing is
// sent and nothing is billed.
//
// Pins: the first send AND the resend each carry a token (a resend replaying
// a spent token would be refused as timeout-or-duplicate), the backend guard
// accepts them (the code step opens, no "Security check failed"), and the
// enforced CSP lets api.js and the challenge iframe load.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:4100';
const OUT = process.argv[3] ?? 'docs/research';
const INTERACTIVE = process.env.PW_INTERACTIVE === '1';
// 360 is the narrow-phone case: the slot must fall back to the compact widget.
const WIDTH = Number(process.env.PW_WIDTH ?? 390);
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
mkdirSync(OUT, { recursive: true });

// A fresh unclaimed +60 11-xxxx xxxx number per run.
const digits = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
const NATIONAL_PHONE = `011-${digits.slice(0, 4)} ${digits.slice(4)}`;
const stamp = Date.now().toString(36);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: 844 } });

// Server-action POSTs carry the action's arguments as JSON in the body.
const sends = [];
page.on('request', (req) => {
  if (req.method() === 'POST' && req.headers()['next-action']) {
    const body = req.postData() ?? '';
    if (body.includes('"purpose"')) sends.push(body);
  }
});
const cspErrors = [];
// Only Turnstile's own violations: a local DB's image rows can point at a
// backend port the build's img-src does not name, which is not this check.
page.on('console', (msg) => {
  const text = msg.text();
  if (
    msg.type() === 'error' &&
    /Content Security Policy/i.test(text) &&
    text.includes('challenges.cloudflare.com')
  )
    cspErrors.push(text);
});
const tokenSends = () => sends.filter((b) => b.includes(DUMMY_TOKEN)).length;

// The forced-interactive key draws its checkbox in our slot. Turnstile keeps
// its iframe in a CLOSED shadow root, so no locator reaches it: wait for the
// slot to take height, then click the checkbox by position with a real
// pointer path (a bare synthetic click does not complete the challenge).
async function solveInteractive(slot, label) {
  const shown = await page
    .waitForFunction(
      (el) => el.getBoundingClientRect().height > 40,
      await slot.elementHandle(),
      { timeout: 20000 },
    )
    .then(
      () => true,
      () => false,
    );
  check(shown, `${label}: checkbox renders in the slot`);
  await slot.screenshot({ path: `${OUT}/qa-turnstile-${label}-challenge.png` });
  // The widget is centred in the slot (compact on narrow phones), so aim at
  // its own box, not the slot's left edge.
  const box = await slot.locator('div').first().boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.move(box.x + 28, box.y + 34, { steps: 8 });
  await page.mouse.down();
  await page.mouse.up();
}

await page.goto(`${BASE}/?auth=signup`, { waitUntil: 'load', timeout: 60000 });
await page.getByPlaceholder('Username').fill(`qa_ts_${stamp}`);
await page.getByPlaceholder('Email').fill(`qa-turnstile-${stamp}@test.dev`);
await page.getByPlaceholder('Phone number').fill(NATIONAL_PHONE);
await page
  .getByPlaceholder('Password', { exact: true })
  .fill('TurnstileQa123!');
await page.getByPlaceholder('Confirm password').fill('TurnstileQa123!');
await page.screenshot({ path: `${OUT}/qa-turnstile-1-form.png` });
await page.getByRole('button', { name: 'Create account' }).click();

if (INTERACTIVE)
  // The slot sits directly above "Create account", inside the dialog.
  await solveInteractive(
    page
      .getByRole('button', { name: 'Create account' })
      .locator('xpath=preceding-sibling::div[1]'),
    'signup',
  );

const codeStep = await page
  .getByPlaceholder('Verification code')
  .waitFor({ state: 'visible', timeout: 30000 })
  .then(
    () => true,
    () => false,
  );
check(codeStep, 'first send passes the guard and opens the code step');
check(
  tokenSends() === 1,
  `first send carried a token (${tokenSends()} so far)`,
);
await page.screenshot({ path: `${OUT}/qa-turnstile-3-code-step.png` });

// Resend after the 30 s cooldown — must mint a NEW token, not replay.
const resend = page.getByRole('button', { name: 'Resend code' });
await resend.waitFor({ state: 'visible', timeout: 45000 });
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent?.trim() === 'Resend code' && !b.disabled,
    ),
  null,
  { timeout: 45000 },
);
await resend.click();
if (INTERACTIVE)
  // PhoneOtpStep's own slot, directly under its Back / Resend row.
  await solveInteractive(
    page
      .getByRole('button', { name: 'Back' })
      .locator('xpath=../following-sibling::div[1]'),
    'resend',
  );
await page.waitForTimeout(4000);
check(
  tokenSends() === 2,
  `resend carried its own token (${tokenSends()} sends with tokens)`,
);
check(
  !(await page.getByText('Security check failed').isVisible()),
  'no "Security check failed" after the resend',
);
await page.screenshot({ path: `${OUT}/qa-turnstile-4-resent.png` });

check(
  cspErrors.length === 0,
  `no Turnstile CSP violations (${cspErrors.length})`,
);
check(
  await page
    .locator('script[src^="https://challenges.cloudflare.com/turnstile/"]')
    .count()
    .then((n) => n === 1),
  'Turnstile api.js loaded exactly once',
);
for (const e of cspErrors.slice(0, 3)) console.log(`  csp: ${e.slice(0, 160)}`);

await browser.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
