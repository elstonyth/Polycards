// QA: the Vault tab unread dot, end to end against the :4000 production
// standalone build (never `next dev` — see CLAUDE.md).
//
//   npm run build
//   pwsh scripts/serve-standalone.ps1 -Port 4000     # in another shell
//   node scripts/qa-vault-dot.mjs
//
// Logs in the way qa-daily-storefront-walk.mjs does: mint a customer JWT at
// :9000 and set the storefront's httpOnly `_polycards_jwt` cookie directly,
// which sidesteps the flaky UI login stack.
//
// Screenshots land in docs/research/vault-dot-*.png.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const FRONT = 'http://localhost:4000';
const API = 'http://localhost:9000';
const CUST = {
  email: process.env.QA_CUSTOMER_EMAIL ?? 'test@polycards.app',
  password: process.env.QA_CUSTOMER_PASSWORD ?? 'PolycardsTest123!',
};

mkdirSync('docs/research', { recursive: true });
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failures++;
};

// Environment first, so a runner with no local env file can still work; the
// dev-machine file is the fallback. Resolved at run time either way, so the key
// never reaches a transcript or a log line.
const PUB = (() => {
  const fromEnv = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY;
  if (fromEnv) return fromEnv.trim();
  let file;
  try {
    file = readFileSync('.env.local', 'utf8');
  } catch {
    throw new Error(
      'NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY is unset and the local env file is unreadable',
    );
  }
  const line = file
    .split(/\r?\n/)
    .find((l) => l.startsWith('NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY='));
  if (!line) throw new Error('NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY missing');
  return line.slice(line.indexOf('=') + 1).trim();
})();

const MAX_ATTEMPTS = 6;

// Auth + store routes are rate-limited — retry 429s with a pause. A REJECTED
// fetch is retried too and then reported as a plain sentence: the backend being
// down on :9000 is the most common way to run this script wrong, and a bare
// `TypeError: fetch failed` stack does not say so.
async function call(url, init) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (cause) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(
          `cannot reach ${url} after ${attempt + 1} tries — is the backend up on ${API}?`,
          { cause },
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    return res;
  }
}

const cust = await call(`${API}/auth/customer/emailpass`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(CUST),
}).then((r) => r.json());
if (!cust.token)
  throw new Error(`customer auth failed: ${JSON.stringify(cust)}`);

const CH = {
  Authorization: `Bearer ${cust.token}`,
  'x-publishable-api-key': PUB,
};

// ---------------------------------------------------------------- API contract
console.log('\n--- API ---');

const unauthed = await call(`${API}/store/vault/latest`, {
  headers: { 'x-publishable-api-key': PUB },
});
check(
  unauthed.status === 401,
  `unauthenticated /store/vault/latest 401s (got ${unauthed.status})`,
);

const latestRes = await call(`${API}/store/vault/latest`, { headers: CH });
check(
  latestRes.status === 200,
  `authed /store/vault/latest 200s (got ${latestRes.status})`,
);
const latest = await latestRes.json();
check('latest_event_at' in latest, 'response carries latest_event_at');
console.log(`   latest_event_at = ${latest.latest_event_at}`);

const vault = await call(`${API}/store/vault`, { headers: CH }).then((r) =>
  r.json(),
);
const vaultCount = vault.items?.length ?? 0;
console.log(`   vault holds ${vaultCount} item(s)`);
check(
  vaultCount > 0,
  'test customer has a non-empty vault (the dot needs one)',
);
check(
  latest.latest_event_at !== null,
  'latest_event_at is non-null for a non-empty vault',
);

const creditsRes = await call(`${API}/store/credits/latest`, { headers: CH });
check(
  creditsRes.status === 200,
  `authed /store/credits/latest 200s (got ${creditsRes.status})`,
);
const credits = await creditsRes.json();
console.log(`   credits latest_event_at = ${credits.latest_event_at}`);
check(
  credits.latest_event_at !== null,
  'credits latest_event_at is non-null for a customer with ledger rows',
);

const creditsAnon = await call(`${API}/store/credits/latest`, {
  headers: { 'x-publishable-api-key': PUB },
});
check(
  creditsAnon.status === 401,
  `unauthenticated /store/credits/latest 401s (got ${creditsAnon.status})`,
);

// ------------------------------------------------------------------- rendering
// Both navs carry aria-label="Primary" and the desktop one is `hidden lg:flex`
// (present in the DOM, display:none), so count only what is actually visible.
async function visibleWithLabel(page, label) {
  const all = page.locator(`a[aria-label="${label}"]`);
  const n = await all.count();
  let visible = 0;
  for (let i = 0; i < n; i++) if (await all.nth(i).isVisible()) visible++;
  return visible;
}

async function visibleDots(page) {
  return visibleWithLabel(page, 'Vault, new items');
}

async function visibleMoneyDots(page) {
  return visibleWithLabel(page, 'Me, new items');
}

// The dot appears only after getVaultLatest() resolves client-side.
async function waitForDot(page, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const n = await visibleDots(page);
    if (n > 0) return n;
    if (Date.now() - start > timeoutMs) return n;
    await page.waitForTimeout(500);
  }
}

const browser = await chromium.launch({ headless: true });
const cookie = {
  name: '_polycards_jwt',
  value: cust.token,
  url: FRONT,
  httpOnly: true,
  sameSite: 'Lax',
};

try {
  // --- 1. mobile TabBar: lit, then cleared by a vault visit -------------------
  console.log('\n--- mobile TabBar (420x900) ---');
  const mobile = await browser.newContext({
    viewport: { width: 420, height: 900 },
  });
  await mobile.addCookies([cookie]);
  const page = await mobile.newPage();

  await page.goto(FRONT, { waitUntil: 'domcontentloaded', timeout: 20000 });
  check((await waitForDot(page)) === 1, 'dot is lit on the Vault tab');
  await page.screenshot({
    path: 'docs/research/vault-dot-mobile-lit.png',
    fullPage: false,
  });

  // Clearing: open /vault, then come back and let the fetch settle before
  // asserting absence — asserting too early would pass for the wrong reason.
  await page.goto(`${FRONT}/vault`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(4000);

  const stampKeys = await page.evaluate(() =>
    Object.keys(window.localStorage).filter((k) =>
      k.startsWith('polycards.vault_seen_at'),
    ),
  );
  check(
    stampKeys.length === 1,
    `exactly one stamp key (got ${stampKeys.length})`,
  );
  check(
    stampKeys[0] !== 'polycards.vault_seen_at' &&
      /^polycards\.vault_seen_at:cus_/.test(stampKeys[0] ?? ''),
    `stamp key is customer-scoped: ${stampKeys[0]}`,
  );

  await page.goto(FRONT, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(4000);
  check(
    (await visibleDots(page)) === 0,
    'dot is cleared after visiting /vault',
  );
  await page.screenshot({
    path: 'docs/research/vault-dot-mobile-cleared.png',
    fullPage: false,
  });
  await mobile.close();

  // --- 1b. logout: a lit dot must go dark when the session ends -------------
  // The provider writes NO state on logout (a synchronous setState in an effect
  // body is rejected by react-hooks/set-state-in-effect). The stale value stays
  // in memory and only the `live` derivation hides it — so that derivation is
  // load-bearing and gets its own check rather than being taken on faith.
  console.log('\n--- logout (420x900) ---');
  const session = await browser.newContext({
    viewport: { width: 420, height: 900 },
  });
  await session.addCookies([cookie]);
  const sessionPage = await session.newPage();
  await sessionPage.goto(FRONT, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  check((await waitForDot(sessionPage)) === 1, 'dot is lit while signed in');

  await session.clearCookies();
  await sessionPage.goto(FRONT, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await sessionPage.waitForTimeout(4000);
  check(
    (await visibleDots(sessionPage)) === 0,
    'dot goes dark after the session ends',
  );
  await session.close();

  // --- 2. desktop AppHeader: fresh context, so the dot is lit again ----------
  console.log('\n--- desktop AppHeader (1440x900) ---');
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await desktop.addCookies([cookie]);
  const wide = await desktop.newPage();

  await wide.goto(FRONT, { waitUntil: 'domcontentloaded', timeout: 20000 });
  check((await waitForDot(wide)) === 1, 'dot is lit in the desktop nav');
  await wide.screenshot({
    path: 'docs/research/vault-dot-desktop-lit.png',
    fullPage: false,
  });
  await desktop.close();

  // --- 2b. money dot: Me tab + the /me History tile, cleared by /transactions -
  console.log('\n--- money dot (420x900) ---');
  const money = await browser.newContext({
    viewport: { width: 420, height: 900 },
  });
  await money.addCookies([cookie]);
  const moneyPage = await money.newPage();

  await moneyPage.goto(FRONT, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  const moneyLit = await (async () => {
    const start = Date.now();
    for (;;) {
      const n = await visibleMoneyDots(moneyPage);
      if (n > 0) return n;
      if (Date.now() - start > 20000) return n;
      await moneyPage.waitForTimeout(500);
    }
  })();
  check(moneyLit === 1, 'money dot is lit on the Me tab');
  await moneyPage.screenshot({
    path: 'docs/research/vault-dot-money-lit.png',
    fullPage: false,
  });

  // The in-page marker (the second half of the request): the History tile on
  // /me carries the same signal, reached via the sr-only text it appends.
  await moneyPage.goto(`${FRONT}/me`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await moneyPage.waitForTimeout(3000);
  const tile = moneyPage.locator('a[href="/transactions"]');
  check(
    (await tile.count()) > 0 &&
      (await tile.first().innerText()).includes('History'),
    'the /me History tile is present',
  );
  check(
    ((await tile.first().getAttribute('aria-label')) ?? '')
      .concat(await tile.first().innerText())
      .includes('new activity'),
    'the History tile announces new activity to screen readers',
  );
  await moneyPage.screenshot({
    path: 'docs/research/vault-dot-money-tile.png',
    fullPage: false,
  });

  await moneyPage.goto(`${FRONT}/transactions`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await moneyPage.waitForTimeout(4000);

  const creditStamp = await moneyPage.evaluate(() =>
    Object.keys(window.localStorage).filter((k) =>
      k.startsWith('polycards.credits_seen_at'),
    ),
  );
  check(
    creditStamp.length === 1 &&
      /^polycards\.credits_seen_at:cus_/.test(creditStamp[0] ?? ''),
    `money stamp is customer-scoped and its own namespace: ${creditStamp[0]}`,
  );
  // The two dots must not share a stamp: clearing money must leave the vault
  // dot alone. Both keys should now exist independently.
  const vaultStamp = await moneyPage.evaluate(() =>
    Object.keys(window.localStorage).filter((k) =>
      k.startsWith('polycards.vault_seen_at'),
    ),
  );
  check(
    vaultStamp.length === 0,
    'clearing the money dot did NOT touch the vault stamp',
  );

  await moneyPage.goto(FRONT, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await moneyPage.waitForTimeout(4000);
  check(
    (await visibleMoneyDots(moneyPage)) === 0,
    'money dot is cleared after visiting /transactions',
  );
  check(
    (await visibleDots(moneyPage)) === 1,
    'the vault dot is still lit — the two dots are independent',
  );
  await money.close();

  // --- 3. logged out: no dot, no request ------------------------------------
  console.log('\n--- logged out (420x900) ---');
  const anon = await browser.newContext({
    viewport: { width: 420, height: 900 },
  });
  const anonPage = await anon.newPage();
  let latestCalls = 0;
  anonPage.on('request', (r) => {
    if (r.url().includes('/store/vault/latest')) latestCalls++;
  });
  await anonPage.goto(FRONT, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await anonPage.waitForTimeout(4000);
  check((await visibleDots(anonPage)) === 0, 'no dot for a signed-out visitor');
  check(
    latestCalls === 0,
    `signed-out visitor makes no /latest call (${latestCalls})`,
  );
  await anon.close();
} finally {
  await browser.close();
}

console.log(
  `\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — screenshots in docs/research/vault-dot-*.png`,
);
process.exit(failures === 0 ? 0 : 1);
