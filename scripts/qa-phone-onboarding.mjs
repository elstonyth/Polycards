// qa-phone-onboarding.mjs — the required-phone gate over the account pages.
// Usage: node scripts/qa-phone-onboarding.mjs [baseUrl] [outDir]
//
// Runs against a prod build that was built with
// NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED=true — the account layout gates on
// that flag. Two cohorts:
//
//   A. PW_JWT_FILE — a session token for a Google-only, phoneless customer,
//      minted by backend/packages/api/src/scripts/qa-mint-google-customer.ts
//      (the real cohort; it has no password). Expects the gate on every
//      account page, no dismiss, the voice-call first send, and the whole
//      entry → code → save loop.
//      Locally the backend's dev transport logs a fixed code instead of
//      texting (PW_OTP_CODE, default 000000), so the run LEAVES THAT CUSTOMER
//      WITH A PHONE — mint a fresh one per run. PW_PHONE picks an unclaimed
//      number in national format (default 017-555 1234).
//   B. PW_PASSWORD (else scripts/.dev-logins CUST_PW, else the shared dev
//      default) — the emailpass dev login, which is phoneless too. Expects NO
//      gate: a password account is asked for its password before it can add a
//      phone, and the gate has no field for it. Skipped with PW_SKIP_EMAILPASS.
//
// Nothing secret is printed.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const OUT = process.argv[3] ?? 'docs/research';
const EMAIL = process.env.PW_EMAIL ?? 'test@polycards.app';
const PASSWORD =
  process.env.PW_PASSWORD ?? devLogin('CUST_PW') ?? 'PolycardsTest123!';
const OTP_CODE = process.env.PW_OTP_CODE ?? '000000';
const PHONE = process.env.PW_PHONE ?? '017-555 1234';
mkdirSync(OUT, { recursive: true });

function devLogin(key) {
  try {
    const line = readFileSync('scripts/.dev-logins', 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

let failures = 0;
const ok = (msg) => console.log(`PASS ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`FAIL ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const browser = await chromium.launch();

async function newPage() {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  // The Meta pixel never settles, so nothing here waits for networkidle.
  await page.route(/connect\.facebook\.net/, (r) => r.abort());
  await page.goto(BASE + '/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page
    .getByRole('button', { name: /^reject$/i })
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
  return { ctx, page };
}

const gateOf = (page) =>
  page.getByRole('dialog', { name: 'Verify your phone' });

async function open(page, route) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  // The entry form needs React for onSubmit (unhydrated, it would GET-submit).
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
}

// ── A. Google-only, phoneless: the gate, end to end ─────────────────────────
if (process.env.PW_JWT_FILE) {
  const { ctx, page } = await newPage();
  const { hostname } = new URL(BASE);
  await ctx.addCookies([
    {
      name: '_polycards_jwt',
      value: readFileSync(process.env.PW_JWT_FILE, 'utf8').trim(),
      domain: hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const gate = gateOf(page);
  const errorSlot = page.locator('#phone-onboarding-error');
  const shot = (name) =>
    page.screenshot({ path: path.join(OUT, `phone-onboarding-${name}.png`) });

  await open(page, '/me');
  if (!page.url().endsWith('/me')) {
    fail(`A: session did not stick (landed on ${page.url()})`);
    process.exit(1);
  }
  await gate.waitFor({ state: 'visible', timeout: 10000 });
  ok('A: /me shows the gate for a phoneless Google-only account');
  check(
    (await gate.getByRole('button', { name: /skip/i }).count()) === 0,
    'A: no Skip control',
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check((await gate.count()) === 1, 'A: Escape does not close it');
  check(
    (await gate.getByRole('button', { name: 'Log out' }).count()) === 1,
    'A: Log out is offered as the way out',
  );
  await shot('entry-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  await shot('entry-desktop');
  await page.setViewportSize({ width: 390, height: 844 });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  check((await gate.count()) === 1, 'A: refresh keeps the gate');
  await open(page, '/settings');
  check((await gate.count()) === 1, 'A: /settings is gated too');
  await open(page, '/me');
  await gate.waitFor({ state: 'visible', timeout: 10000 });

  await gate.getByLabel('Phone number').fill('123');
  await gate.getByRole('button', { name: 'Send code' }).click();
  await page.waitForTimeout(400);
  const invalid = await errorSlot.textContent();
  check(
    /valid phone number/i.test(invalid ?? ''),
    `A: invalid number: "${invalid}"`,
  );
  await shot('invalid');

  // Voice-call first send: the code step must open on the call copy. Then
  // Back, and continue by SMS (two of the 3-per-10-min per-phone budget).
  await gate.getByLabel('Phone number').fill(PHONE);
  await gate.getByRole('button', { name: /get a call instead/i }).click();
  const codeInput = gate.getByPlaceholder('Verification code');
  await codeInput.waitFor({ state: 'visible', timeout: 15000 });
  check(
    /calling/i.test((await gate.textContent()) ?? ''),
    'A: "Get a call instead" opens the code step on the call copy',
  );
  check(
    (await gate.getByRole('button', { name: 'Call again' }).count()) === 1,
    'A: call path offers "Call again"',
  );
  await shot('code-step-call');
  await gate.getByRole('button', { name: 'Back' }).click();
  await gate.getByRole('button', { name: 'Send code' }).waitFor({
    state: 'visible',
    timeout: 5000,
  });
  check(
    (await gate.getByLabel('Phone number').inputValue()) === PHONE,
    'A: Back keeps the number',
  );

  await gate.getByRole('button', { name: 'Send code' }).click();
  await errorSlot
    .filter({ hasText: /./ })
    .or(codeInput)
    .first()
    .waitFor({ state: 'visible', timeout: 15000 });
  if ((await codeInput.count()) === 0) {
    fail(`A: send refused with "${await errorSlot.textContent()}"`);
  } else {
    ok('A: valid number: moved to the code step');
    await shot('code-step');
    await codeInput.fill(OTP_CODE);
    await gate.getByRole('button', { name: 'Verify' }).click();
    await gate.waitFor({ state: 'detached', timeout: 15000 });
    ok('A: verified: gate gone');
    await page.waitForTimeout(1500); // router.refresh()
    await shot('after-verify');
    check(
      (await page.getByText('add your phone number').count()) === 0,
      'A: Settings tile highlight cleared after refresh',
    );
    await open(page, '/settings');
    check((await gate.count()) === 0, 'A: /settings no longer gated');
    const saved = await page
      .getByLabel('Phone (read-only)')
      .inputValue()
      .catch(() => null);
    check(saved === PHONE, `A: settings shows the saved number (${saved})`);
    await shot('settings-after');
  }
  await ctx.close();
} else {
  console.log('SKIP A: PW_JWT_FILE not set (see header)');
}

// ── B. emailpass, phoneless: no gate (password cohort keeps Settings) ───────
if (!process.env.PW_SKIP_EMAILPASS) {
  const { ctx, page } = await newPage();
  await page.getByRole('button', { name: 'Login' }).first().click();
  await page.getByPlaceholder('Email').last().fill(EMAIL);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.keyboard.press('Enter');
  // The modal closing is the login signal — "RM" text is on every page.
  await page
    .locator('[role="dialog"]')
    .waitFor({ state: 'detached', timeout: 20000 });
  await open(page, '/me');
  if (!page.url().endsWith('/me')) {
    fail(`B: login did not stick (landed on ${page.url()})`);
  } else {
    const phoneless =
      (await page.getByText('add your phone number').count()) === 1;
    if (!phoneless) {
      console.log(
        'SKIP B: the emailpass dev login has a phone; nothing to gate',
      );
    } else {
      check(
        (await gateOf(page).count()) === 0,
        'B: a phoneless PASSWORD account is not gated (Settings flow instead)',
      );
    }
  }
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
