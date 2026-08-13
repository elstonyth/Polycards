// Browser verification for the useModalA11y focus-trap fix: focus that lands
// OUTSIDE the panel — the case a real browser produces by blurring to <body>
// when the focused element becomes `disabled` — is pulled back in on Tab.
//
//   npm run build && pwsh scripts/serve-standalone.ps1 -Port 4100   (background)
//   node scripts/qa-modal-focus-trap.mjs [storefront-port]
//
// Driven through AuthModal because it is the one hook-using dialog reachable
// without a login (?auth=login opens it), and it was migrated onto the hook in
// this change — so this covers both the fix and the migration. The unit test
// (src/lib/__tests__/modal-focus-trap.test.ts) pins the same logic, but asserts
// the blur-to-body precondition rather than producing it; only a real browser
// does that for real. vitest also collects `*.test.ts` only, so nothing in CI
// exercises AuthModal.tsx itself.
//
// Screenshot to docs/research/qa-modal-focus-trap.png.
import { chromium } from 'playwright';

process.loadEnvFile('.env.local');
const BASE = `http://localhost:${process.argv[2] || '4100'}`;
const BACKEND = `http://localhost:${process.argv[3] || '9000'}`;
// Read, never printed — this is a live key.
const PK = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY;
// `aria-modal` matters: the cookie-consent banner is also a role="dialog", and
// it sits in the same document while the auth modal is open.
const PANEL = '[role="dialog"][aria-modal="true"]';

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/** Where focus is, relative to the dialog panel. */
const focusState = (page) =>
  page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    const a = document.activeElement;
    return {
      hasPanel: !!panel,
      isBody: a === document.body,
      isPanel: a === panel,
      inside: !!panel && !!a && panel.contains(a),
      tag: a?.tagName ?? null,
      label:
        a?.getAttribute('aria-label') ?? a?.textContent?.trim().slice(0, 24),
    };
  }, PANEL);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  console.error: ${m.text()}`);
});

await page.goto(`${BASE}/?auth=login`, { waitUntil: 'networkidle' });
await page.waitForSelector(PANEL, { timeout: 10_000 });

// 1. Open moves focus into the panel.
let s = await focusState(page);
check(s.hasPanel, 'auth modal opens from ?auth=login');
check(s.isPanel, `open focuses the panel itself (focus on ${s.tag})`);

// 2. Shift+Tab off the panel wraps to the last control rather than escaping —
//    the first keypress after every open, and the case a pure containment
//    check drops (a panel contains itself).
await page.keyboard.press('Shift+Tab');
s = await focusState(page);
check(
  s.inside && !s.isPanel,
  `Shift+Tab from the panel wraps inside (${s.label})`,
);

// 3. THE REGRESSION. Disable the focused control the way a busy state does and
//    let the browser blur it — then Tab must come back into the panel instead
//    of walking out into the page behind it.
await page.evaluate(() => {
  const a = document.activeElement;
  if (a instanceof HTMLButtonElement || a instanceof HTMLInputElement)
    a.disabled = true;
});
s = await focusState(page);
check(s.isBody, 'disabling the focused control blurs to <body> (precondition)');

await page.keyboard.press('Tab');
s = await focusState(page);
check(s.inside, `Tab from <body> is pulled back into the panel (${s.label})`);

// 4. Escape still closes after the migration off the hand-rolled trap.
await page.keyboard.press('Escape');
await page.waitForSelector(PANEL, {
  state: 'detached',
  timeout: 5_000,
});
check(true, 'Escape closes the dialog');

// 5. And the body scroll lock is released on close (the hook's refcount).
const overflow = await page.evaluate(() => document.body.style.overflow);
check(
  overflow !== 'hidden',
  `body scroll unlocked on close (overflow="${overflow}")`,
);

// 6. The migration moved Escape onto a ref-read callback, so check it still
//    reaches the reactivate DISMISSAL rather than a plain close: on this mode
//    a dismissal means "Not now" and must log the session out, and a silent
//    close is what strands the customer on a live token. The Google callback
//    lands here exactly this way (/?auth=reactivate). Observed as the logout
//    server action being POSTed — with no backend up it fails downstream, which
//    is fine: dismiss() swallows that and closes either way. What is NOT
//    covered here is the AuthForm handover, where the mode flips after open —
//    that needs a real login. The stale-callback risk it carries is pinned in
//    modal-focus-trap.test.ts instead.
const posts = [];
page.on('request', (r) => {
  if (r.method() === 'POST') posts.push(r.url());
});
await page.goto(`${BASE}/?auth=reactivate`, { waitUntil: 'networkidle' });
await page.waitForSelector(PANEL);
const reactivateShown = await page
  .getByText('Your account is disabled')
  .isVisible();
check(reactivateShown, 'reactivate prompt renders from ?auth=reactivate');

posts.length = 0;
await page.keyboard.press('Escape');
await page.waitForSelector(PANEL, { state: 'detached', timeout: 5_000 });
check(
  posts.length > 0,
  `Escape on reactivate fires the logout action, not a silent close (${posts.length} POST)`,
);

await page.screenshot({ path: 'docs/research/qa-modal-focus-trap.png' });

// ---------------------------------------------------------------------------
// Phase B: the two login-gated dialogs. DangerZone is where the bug was
// reported (its retry button is disabled while it holds focus), and
// SellConfirmModal is the other dialog migrated off a hand-rolled trap.
// Needs a backend carrying this branch's routes; skipped, loudly, without one.
// ---------------------------------------------------------------------------
const backendUp = await fetch(`${BACKEND}/health`)
  .then((r) => r.ok)
  .catch(() => false);

if (!backendUp) {
  console.log(
    `\nSKIP  DangerZone + SellConfirmModal — no backend on ${BACKEND}`,
  );
} else {
  const EMAIL = `qa-trap-${Date.now()}@test.dev`;
  const PASSWORD = 'TrapQA12345!';
  const api = (path, token, body) =>
    fetch(`${BACKEND}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-publishable-api-key': PK,
        'idempotency-key': `trap-${Date.now()}-${Math.random()}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });

  // Register, then link the customer, then log in again: the register token
  // carries an empty actor_id until POST /store/customers runs.
  const reg = await api('/auth/customer/emailpass/register', null, {
    email: EMAIL,
    password: PASSWORD,
  });
  const { token: regToken } = await reg.json();
  await api('/store/customers', regToken, { email: EMAIL });
  const li = await api('/auth/customer/emailpass', null, {
    email: EMAIL,
    password: PASSWORD,
  });
  const { token } = await li.json();

  // Credit, then one pack open so the vault has something sellable.
  await api('/store/credits/topup', token, { amount: 200 });
  const packs = await fetch(`${BACKEND}/store/packs`, {
    headers: { 'x-publishable-api-key': PK },
  }).then((r) => r.json());
  const slug = packs?.packs?.find((p) => p.slug)?.slug;
  const opened = await api(`/store/packs/${slug}/open`, token);
  check(opened.ok, `seeded a vault card from /store/packs/${slug}/open`);

  // Log in through the UI so the storefront holds a real session.
  await page.goto(`${BASE}/?auth=login`, { waitUntil: 'networkidle' });
  await page.waitForSelector(PANEL);
  // Scoped to the panel: the header carries its own "Login" button.
  const form = page.locator(PANEL);
  await form.getByLabel(/email/i).fill(EMAIL);
  await form
    .getByLabel(/password/i)
    .first()
    .fill(PASSWORD);
  await form.getByRole('button', { name: /^log ?in$/i }).click();
  await page.waitForSelector(PANEL, { state: 'detached', timeout: 15_000 });

  /** The reported repro, run against a real dialog: disable the focused
   *  control, let the browser blur it to <body>, then Tab. */
  async function trapHoldsAfterDisable(label) {
    let st = await focusState(page);
    check(st.inside || st.isPanel, `${label}: focus starts inside the panel`);
    await page.evaluate((sel) => {
      const panel = document.querySelector(sel);
      const btn = panel?.querySelector('button:not([disabled])');
      btn?.focus();
      if (btn) btn.disabled = true;
    }, PANEL);
    st = await focusState(page);
    check(st.isBody, `${label}: disabling the focused button blurs to <body>`);
    await page.keyboard.press('Tab');
    st = await focusState(page);
    check(
      st.inside,
      `${label}: Tab is pulled back into the panel (${st.label})`,
    );
  }

  // B1. DangerZone — /settings, "Disable account".
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page
    .getByRole('button', { name: /disable account/i })
    .first()
    .click();
  await page.waitForSelector(PANEL, { timeout: 10_000 });
  await trapHoldsAfterDisable('DangerZone');
  await page.screenshot({
    path: 'docs/research/qa-modal-focus-trap-danger.png',
  });
  await page.keyboard.press('Escape');
  await page.waitForSelector(PANEL, { state: 'detached', timeout: 5_000 });
  check(true, 'DangerZone: Escape still closes after the hook change');

  // B2. SellConfirmModal — /vault, select a card, Sell. The action bar holding
  // the Sell button renders only once cookie consent has been ANSWERED
  // (`consent !== null` in VaultClient), so an undismissed banner means there
  // is no Sell button to click at all.
  await page.goto(`${BASE}/vault`, { waitUntil: 'networkidle' });
  await page
    .getByRole('button', { name: /^reject$/i })
    .click()
    .catch(() => {});
  await page
    .getByRole('button', { name: /^select /i })
    .first()
    .click();
  await page.getByRole('button', { name: /^sell/i }).first().click();
  await page.waitForSelector(PANEL, { timeout: 10_000 });
  await trapHoldsAfterDisable('SellConfirmModal');
  await page.screenshot({ path: 'docs/research/qa-modal-focus-trap-sell.png' });
  await page.keyboard.press('Escape');
  await page.waitForSelector(PANEL, { state: 'detached', timeout: 5_000 });
  check(true, 'SellConfirmModal: Escape still closes after the migration');
}

await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
