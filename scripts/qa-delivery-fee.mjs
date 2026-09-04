// QA the shipping-fee UI end to end against a real storefront build.
//
// Sets a customer up through the real store API (register → topup → open a
// pack so the vault has a card), then drives the vault UI: selects the card,
// opens the delivery modal, and checks the fee breakdown for a West address,
// an East address, and a non-Malaysian one (which must block the submit).
//
// Usage: PW_BASE=http://127.0.0.1:4100 node scripts/qa-delivery-fee.mjs
// Screenshots land in docs/research/qa-delivery-fee-*.png.
import { chromium } from '@playwright/test';

const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4100';
const BACKEND = process.env.PW_BACKEND ?? 'http://127.0.0.1:9000';
const PK =
  process.env.PW_PK ??
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const PASSWORD = 'PwE2e2026!';
const stamp = String(Date.now());
const EMAIL = `qa-fee-${stamp}@test.dev`;

const api = async (
  path,
  { method = 'GET', token, body, headers = {} } = {},
) => {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-publishable-api-key': PK,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
};

// --- 1. Seed a funded customer holding one vaulted card -------------------
const reg = await api('/auth/customer/emailpass/register', {
  method: 'POST',
  body: { email: EMAIL, password: PASSWORD },
});
await api('/store/customers', {
  method: 'POST',
  token: reg.token,
  body: {
    email: EMAIL,
    // Unique per run — the username is the profile URL, so it cannot repeat.
    first_name: `QaFee${stamp}`.slice(0, 30),
    last_name: 'Fee',
    // Phone is unique per customer (registration gate) — derive it from the
    // run stamp so reruns never collide on an already-used number.
    phone: `+601${stamp.slice(-8)}`,
  },
});
const login = await api('/auth/customer/emailpass', {
  method: 'POST',
  body: { email: EMAIL, password: PASSWORD },
});
const token = login.token;

const { packs } = await api('/store/packs', { token });
const pack = [...packs].sort((a, b) => a.price - b.price)[0];
await api('/store/credits/topup', {
  method: 'POST',
  token,
  body: { amount: Math.ceil(pack.price + 100) },
  headers: { 'idempotency-key': `qa-fee-${stamp}` },
});
await api(`/store/packs/${pack.slug}/open`, {
  method: 'POST',
  token,
  body: {},
});
const vault = await api('/store/vault', { token });
check(
  'seed: customer holds a vaulted card',
  (vault.items ?? []).length > 0,
  `pack=${pack.slug} price=RM${pack.price}`,
);

// --- 2. Drive the UI ------------------------------------------------------
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
await ctx.addInitScript(() => {
  try {
    window.localStorage.setItem('polycards.cookie-consent', 'accepted');
  } catch {}
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Log in through the header modal (there is no /login route).
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page
  .getByRole('button', { name: /^log ?in$/i })
  .first()
  .click();
await page.locator('input[type="email"]').first().fill(EMAIL);
await page.locator('input[type="password"]').first().fill(PASSWORD);
await page
  .getByRole('button', { name: /^log ?in$/i })
  .last()
  .click();
await page.waitForTimeout(2500);

await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
await page
  .getByRole('button', { name: /^Select (?!All\b).+/ })
  .first()
  .click();
await page.getByRole('button', { name: /^Deliver 1$/ }).click();
const modal = page.getByRole('dialog', { name: 'Request delivery' });
await modal.waitFor({ timeout: 15_000 });

const fillAddress = async (city, postal, country) => {
  await modal.locator('input[aria-label="First name"]').fill('Qa');
  await modal.locator('input[aria-label="Last name"]').fill('Fee');
  await modal.locator('input[aria-label="Address"]').fill(`${stamp} Test Rd`);
  await modal.locator('input[aria-label="City"]').fill(city);
  await modal.locator('input[aria-label="Postal code"]').fill(postal);
  await modal.locator('input[aria-label="Country code"]').fill(country);
  await modal.getByRole('button', { name: /save address/i }).click();
  await page.waitForTimeout(1500);
};

// West Malaysia — RM15, protection note, no insurance line.
await fillAddress('Kuala Lumpur', '50000', 'MY');
let text = await modal.innerText();
check(
  'West address shows RM15 shipping',
  /West Malaysia/.test(text) && /RM\s?15\.00/.test(text),
);
// Whether insurance applies depends on the seeded card's value, so read it
// off the vault rather than assuming — a demo pack can pull well over RM200.
const cardValue = vault.items[0]?.card?.marketPriceMyr ?? 0;
const expectInsurance = cardValue > 200;
const expectedInsurance = (Math.round(cardValue * 5) / 100).toFixed(2);
check(
  expectInsurance
    ? 'above RM200: insurance line charges 5% of card value'
    : 'at/under RM200: protection-included note, no insurance line',
  expectInsurance
    ? /Insurance \(5%/.test(text) &&
        new RegExp(`RM\\s?${expectedInsurance}`).test(text)
    : /protection up to/i.test(text) && !/Insurance \(5%/.test(text),
  `card=RM${cardValue}${expectInsurance ? ` expect insurance RM${expectedInsurance}` : ''}`,
);
await page.screenshot({ path: 'docs/research/qa-delivery-fee-west.png' });

// Add an East Malaysia address and select it — RM35.
await modal.getByRole('button', { name: /add a new address/i }).click();
await fillAddress('Kota Kinabalu', '88000', 'MY');
text = await modal.innerText();
check(
  'East address shows RM35 shipping',
  /East Malaysia/.test(text) && /RM\s?35\.00/.test(text),
);
await page.screenshot({ path: 'docs/research/qa-delivery-fee-east.png' });

// Zone spoofing (security review 2026-08-25): a Sabah address carrying a KL
// postcode must still price East, not the cheaper West rate.
await modal.getByRole('button', { name: /add a new address/i }).click();
await fillAddress('Kota Kinabalu', '50000', 'MY');
text = await modal.innerText();
check(
  'East city with a West postcode still prices East RM35',
  /East Malaysia/.test(text) && /RM\s?35\.00/.test(text),
);
await page.screenshot({ path: 'docs/research/qa-delivery-fee-spoof.png' });

// An unzonable postcode is refused rather than billed the cheap rate.
await modal.getByRole('button', { name: /add a new address/i }).click();
await fillAddress('Kuala Lumpur', '5000', 'MY');
text = await modal.innerText();
const submitBadPostcode = modal.getByRole('button', {
  name: 'Request delivery',
  exact: true,
});
check(
  'malformed postcode is flagged, not billed West',
  /5-digit Malaysian postcode/i.test(text) && !/Shipping \(West/.test(text),
);
check(
  'malformed postcode disables the submit',
  await submitBadPostcode.isDisabled(),
);

// Non-Malaysian address — blocked, submit disabled.
await modal.getByRole('button', { name: /add a new address/i }).click();
await fillAddress('London', 'EC1A 1AA', 'GB');
text = await modal.innerText();
const submit = modal.getByRole('button', {
  name: 'Request delivery',
  exact: true,
});
check(
  'non-MY address shows the Malaysia-only notice',
  /within Malaysia only/i.test(text),
);
check('non-MY address disables the submit', await submit.isDisabled());
await page.screenshot({ path: 'docs/research/qa-delivery-fee-nonmy.png' });

check(
  'no console/page errors during the flow',
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | '),
);

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
process.exit(failed.length === 0 ? 0 : 1);
