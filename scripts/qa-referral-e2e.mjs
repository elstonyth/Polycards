// qa-referral-e2e.mjs — drives the whole referral loop through the real UI
// against a standalone storefront (PW_BASE, default :4100) + a live backend:
//
//   1. referrer signs up → /referral shows an 8-char code, the /r/<code> link,
//      a QR, and 0 referrals
//   2. logged-in referrer opens their own /r/<code> → "already have an account"
//   3. logged-out visitor opens /r/<code> → banner + signup modal with the
//      code prefilled → creates an account → referrer's panel shows 1
//   4. a fresh visitor (no cookie) TYPES the code into the form → shows 2
//   5. a wrong code is refused before any account/OTP step; a malformed one too
//   6. /r/ZZZZZZZZ → "isn't valid", no modal
//
// Accounts are throwaway (unique per run). With PHONE_VERIFICATION_REQUIRED
// on, the dev OTP (OTP_CODE, default 000000) is entered automatically.
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4100';
const OTP = process.env.OTP_CODE ?? '000000';
const PASSWORD = 'Referral-e2e-pw-1';
const run = Date.now().toString(36);
const account = (tag) => ({
  user: `ref-${tag}-${run}`,
  email: `ref-${tag}-${run}@e2e.test`,
  phone: `012${Math.floor(Math.random() * 10_000_000)
    .toString()
    .padStart(7, '0')}`,
});

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};
const shot = (page, name) =>
  page.screenshot({ path: `docs/research/${name}.png`, fullPage: false });

async function dismissCookies(page) {
  const rej = page.getByRole('button', { name: /reject/i });
  if (await rej.count())
    await rej
      .first()
      .click({ force: true })
      .catch(() => {});
}

async function openModal(page, mode) {
  await page.goto(`${BASE}/?auth=${mode}`, { waitUntil: 'domcontentloaded' });
  await dismissCookies(page);
  await page
    .locator('[role="dialog"][aria-modal="true"]')
    .waitFor({ timeout: 15_000 });
}

async function fillSignup(page, a, referralCode) {
  await page.fill('input[name="username"]', a.user);
  await page.fill('input[name="email"]', a.email);
  await page.getByRole('textbox', { name: 'Phone number' }).fill(a.phone);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="confirmPassword"]', PASSWORD);
  if (referralCode !== undefined) {
    await page.fill('input[name="referralCode"]', referralCode);
  }
}

// Submits and finishes the OTP step when the storefront asks for it. Resolves
// once the modal closes (signup succeeded).
async function submitSignup(page) {
  await page
    .locator('[role="dialog"][aria-modal="true"] button[type="submit"]')
    .click();
  const otp = page.getByRole('textbox', { name: 'Verification code' });
  const asked = await otp.waitFor({ timeout: 6_000 }).then(
    () => true,
    () => false,
  );
  if (asked) {
    await otp.fill(OTP);
    await page
      .getByRole('button', { name: /verify|continue|confirm/i })
      .first()
      .click();
  }
  await page
    .locator('[role="dialog"][aria-modal="true"]')
    .waitFor({ state: 'detached', timeout: 25_000 });
}

async function errorNote(page) {
  return (await page.locator('#auth-form-error').innerText()).trim();
}

async function login(page, a) {
  await openModal(page, 'login');
  await page.fill('input[name="email"]', a.email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.press('input[name="password"]', 'Enter');
  await page
    .locator('[role="dialog"][aria-modal="true"]')
    .waitFor({ state: 'detached', timeout: 25_000 });
}

async function logout(page) {
  await page.goto(`${BASE}/me`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^log out$/i }).click();
  await page.waitForURL((u) => u.pathname === '/', { timeout: 15_000 });
}

async function readPanel(page) {
  await page.goto(`${BASE}/referral`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /copy code/i })
    .waitFor({ timeout: 15_000 });
  const code = (
    await page
      .getByRole('button', { name: /copy code/i })
      .locator('.font-mono')
      .innerText()
  ).trim();
  const link = (
    await page
      .getByRole('button', { name: /copy link/i })
      .locator('.font-mono')
      .innerText()
  ).trim();
  const qr = await page
    .locator('[role="img"][aria-label^="QR code"] svg')
    .count();
  const stat = await page
    .locator('div.rounded-xl', {
      has: page.getByText('Referrals', { exact: true }),
    })
    .first()
    .innerText();
  const referrals = Number((stat.match(/\d+/) ?? ['NaN'])[0]);
  return { code, link, qr, referrals };
}

const browser = await chromium.launch();
const viewport = { width: 430, height: 932 };

// ── 1. referrer ─────────────────────────────────────────────────────────────
const referrer = account('a');
const ctxA = await browser.newContext({ viewport });
const a = await ctxA.newPage();
await openModal(a, 'signup');
await fillSignup(a, referrer);
await submitSignup(a);
let panel = await readPanel(a);
ok(
  /^[A-Z0-9]{8}$/.test(panel.code),
  `referrer has an 8-char code (${panel.code})`,
);
ok(
  panel.link.endsWith(`/r/${panel.code}`),
  `link row is host/r/<code> (${panel.link})`,
);
ok(panel.qr === 1, 'QR renders');
ok(panel.referrals === 0, 'referrals start at 0');
await shot(a, 'referral-panel');
const CODE = panel.code;

// ── 2. logged-in referrer opens their own link ──────────────────────────────
await a.goto(`${BASE}/r/${CODE}`, { waitUntil: 'domcontentloaded' });
await a.waitForTimeout(1500);
ok(
  (await a.getByText('You already have an account').count()) === 1,
  'logged-in visitor: "already have an account" banner',
);
ok(
  (await a.locator('[role="dialog"][aria-modal="true"]').count()) === 0,
  'logged-in visitor: no signup modal',
);
await shot(a, 'referral-has-account');
await ctxA.close();

// ── 3. link recruit: /r/<code> → prefilled form ─────────────────────────────
const recruit = account('b');
const ctxB = await browser.newContext({ viewport });
const b = await ctxB.newPage();
await b.goto(`${BASE}/r/${CODE}`, { waitUntil: 'domcontentloaded' });
await dismissCookies(b);
await b
  .locator('[role="dialog"][aria-modal="true"]')
  .waitFor({ timeout: 15_000 });
ok(
  new URL(b.url()).search === '',
  'landing: ?invite param cleaned from the URL',
);
ok(
  (await b.getByText("You've been invited to Polycards").count()) === 1,
  'landing: invite banner',
);
ok(
  (await b.locator('input[name="referralCode"]').inputValue()) === CODE,
  'landing: signup form prefilled with the code',
);
await shot(b, 'referral-landing');
await fillSignup(b, recruit);
await submitSignup(b);
ok(true, 'link recruit signed up');
await ctxB.close();

// ── 4. typed recruit: no link, no cookie, pastes the code ───────────────────
const typed = account('c');
const ctxC = await browser.newContext({ viewport });
const c = await ctxC.newPage();
await openModal(c, 'signup');
await fillSignup(c, typed, ` ${CODE.toLowerCase()} `);
await submitSignup(c);
ok(true, 'typed recruit signed up with a pasted lowercase code');
await ctxC.close();

// ── 5. bad codes are refused before anything is created ─────────────────────
const bad = account('d');
const ctxD = await browser.newContext({ viewport });
const d = await ctxD.newPage();
await openModal(d, 'signup');
await fillSignup(d, bad, 'ZZZZZZZZ');
await d
  .locator('[role="dialog"][aria-modal="true"] button[type="submit"]')
  .click();
await d.waitForTimeout(2500);
ok(
  /couldn't find that referral code/i.test(await errorNote(d)),
  `unknown code refused: "${await errorNote(d)}"`,
);
ok(
  (await d.locator('[role="dialog"][aria-modal="true"]').count()) === 1,
  'unknown code: modal still open, no OTP step',
);
await shot(d, 'referral-bad-code');
await d.fill('input[name="referralCode"]', 'ABC');
await d
  .locator('[role="dialog"][aria-modal="true"] button[type="submit"]')
  .click();
await d.waitForTimeout(2500);
ok(
  /8 letters and numbers/i.test(await errorNote(d)),
  `malformed code refused: "${await errorNote(d)}"`,
);
await ctxD.close();

// ── 6. unknown link ─────────────────────────────────────────────────────────
const ctxE = await browser.newContext({ viewport });
const e = await ctxE.newPage();
await e.goto(`${BASE}/r/ZZZZZZZZ`, { waitUntil: 'domcontentloaded' });
await e.waitForTimeout(1500);
ok(
  (await e.getByText("That referral link isn't valid").count()) === 1,
  'unknown link: "isn\'t valid" banner',
);
ok(
  (await e.locator('[role="dialog"][aria-modal="true"]').count()) === 0,
  'unknown link: no signup modal',
);
await ctxE.close();

// ── referrer's panel after both recruits ────────────────────────────────────
const ctxF = await browser.newContext({ viewport });
const f = await ctxF.newPage();
await login(f, referrer);
panel = await readPanel(f);
ok(panel.code === CODE, 'code is stable across sessions');
ok(
  panel.referrals === 2,
  `referrer now shows 2 referrals (got ${panel.referrals})`,
);
await shot(f, 'referral-panel-after');
await ctxF.close();

await browser.close();
console.log(
  `\nreferrer: ${referrer.email}\n${failures ? `${failures} FAILED` : 'ALL PASSED'}`,
);
process.exit(failures ? 1 : 0);
