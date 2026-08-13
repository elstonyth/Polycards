// Browser verification for the account-lifecycle review fixes (PR #434):
// declining reactivation logs out, and a self-disabled customer is offered the
// way back on /settings.
//
//   npm run build && pwsh scripts/serve-standalone.ps1 -Port 4000   (background)
//   corepack yarn dev  (from backend/packages/api — health at :9000/health)
//   node scripts/qa-account-reactivate.mjs [storefront-port] [backend-port]
//
// This exists because neither behaviour can be covered by the test suites:
// vitest collects `src/**/*.test.ts` only, and both AuthModal.tsx and
// DangerZone.tsx are `.tsx`. TypeScript covers the prop threading and nothing
// covers the wiring, so the wiring gets checked here instead.
//
// What it pins:
//   1. All THREE dismiss affordances on the reactivate prompt (X, backdrop,
//      Esc) log the customer out. The failure this guards against is a path
//      that was never routed through the "Not now" handler: it closes the
//      modal on a session cookie that is still live, and the customer is left
//      holding a token every route but four 403s, with nothing on screen
//      saying the way out is to log out and back in.
//   2. /settings offers Reactivate to a self-disabled customer, it works, and
//      an ACTIVE account does not see it (the negative half matters: without
//      it, a component that always renders Reactivate passes the positive).
// Plus the rest of the Danger zone and the profile form, because the last
// button shipped on this page lied precisely because its verification covered
// what it built rather than everything the change made reachable.
//
// Screenshots to docs/research/qa-account-reactivate-*.png.
import { chromium } from 'playwright';

process.loadEnvFile('.env.local');
const BASE = `http://localhost:${process.argv[2] || '4000'}`;
const BACKEND = `http://localhost:${process.argv[3] || '9000'}`;
// Read, never printed — this is a live key.
const PK = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY;
const EMAIL = `qa-reactivate-${Date.now()}@test.dev`;
// A SECOND account for the /settings half. The login limiter is 5 per email
// per 60s (createAuthIdentifierRateLimit) and the dismissal loop below spends
// four of them, so reusing the first account there 429s on a correct password
// and the run reads as a UI failure that isn't one.
const EMAIL2 = `qa-reactivate-b-${Date.now()}@test.dev`;
const PASSWORD = 'ReactivateQA123!';

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
// The console message for a failed subresource is just "404 (Not Found)" with
// no URL, which is unactionable — keep the URLs alongside it.
const badResponses = [];
page.on('response', (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
});

const shot = (name) =>
  page.screenshot({ path: `docs/research/qa-account-reactivate-${name}.png` });

/** The Danger zone sits below the fold — an unscrolled shot of /settings
 *  proves nothing about it. */
const shotDangerZone = async (name) => {
  await page
    .getByRole('button', { name: 'Delete account' })
    .scrollIntoViewIfNeeded();
  await shot(name);
};

const jwtCookie = async () =>
  (await page.context().cookies()).find((c) => c.name === '_polycards_jwt')
    ?.value ?? null;

/** Header discriminators: the balance chip only renders for a session the
 *  client believes in, the Login pill only without one. */
const loggedOutHeader = () =>
  page
    .getByRole('button', { name: 'Login', exact: true })
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(
      () => true,
      () => false,
    );

const login = async (email = EMAIL) => {
  await page.goto(`${BASE}/?auth=login`, { waitUntil: 'load', timeout: 60000 });
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
};

const seed = async (email) => {
  const reg = await fetch(`${BACKEND}/auth/customer/emailpass/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  }).then((r) => r.json());
  // The register token's actor_id is empty until this call links the identity.
  const created = await fetch(`${BACKEND}/store/customers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PK,
      Authorization: `Bearer ${reg.token}`,
    },
    body: JSON.stringify({ email }),
  }).then((r) => r.json());
  return created?.customer?.id ?? null;
};

// ── 0. Seed two throwaway customers ─────────────────────────────────────────
check(Boolean(await seed(EMAIL)), 'seed: customer created');
check(Boolean(await seed(EMAIL2)), 'seed: second customer created');

// ── 1. Self-disable from the Danger zone ────────────────────────────────────
await login();
await page
  .getByRole('dialog', { name: 'Log in' })
  .waitFor({ state: 'detached', timeout: 30000 });
await page.goto(`${BASE}/settings`, { waitUntil: 'load', timeout: 60000 });
check(
  await page.getByRole('button', { name: 'Disable account' }).isVisible(),
  'active account: Danger zone offers Disable',
);
check(
  (await page.getByRole('button', { name: 'Reactivate account' }).count()) ===
    0,
  'active account: Danger zone does NOT offer Reactivate',
);
await shotDangerZone('1-active-danger-zone');

await page.getByRole('button', { name: 'Disable account' }).click();
await page
  .getByRole('dialog', { name: 'Disable account' })
  .waitFor({ state: 'visible', timeout: 15000 });
await shot('2-disable-modal');
await page.getByRole('button', { name: 'Disable', exact: true }).click();
check(await loggedOutHeader(), 'disable: signs the customer out');
check((await jwtCookie()) === null, 'disable: session cookie cleared');

// ── 2. Every dismiss affordance on the reactivate prompt is "Not now" ───────
for (const kind of ['X', 'backdrop', 'Escape']) {
  await login();
  const dialog = page.getByRole('dialog', { name: 'Reactivate account' });
  const shown = await dialog.waitFor({ state: 'visible', timeout: 30000 }).then(
    () => true,
    () => false,
  );
  check(shown, `${kind}: login on a self-disabled account offers reactivation`);
  if (kind === 'X') await shot('3-reactivate-prompt');
  // The cookie IS set at this point — that is the whole hazard.
  check((await jwtCookie()) !== null, `${kind}: session cookie is live first`);

  if (kind === 'X') await dialog.getByRole('button', { name: 'Close' }).click();
  else if (kind === 'backdrop')
    // Near the corner, not the element's centre: the backdrop is inset-0, so
    // its centre sits behind the panel and Playwright would refuse the click.
    await page
      .locator('button[aria-hidden="true"].glass-stage')
      .click({ position: { x: 8, y: 8 } });
  else await page.keyboard.press('Escape');

  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  check(await loggedOutHeader(), `${kind}: header renders logged-out after`);
  check((await jwtCookie()) === null, `${kind}: session cookie is gone`);
  await page.reload({ waitUntil: 'load' });
  check(await loggedOutHeader(), `${kind}: still logged out after a reload`);
  check((await jwtCookie()) === null, `${kind}: no cookie after a reload`);
}

// ── 3. The stranded state: /settings offers the way back ────────────────────
// Reached by navigating while the prompt is up — the cookie is already set, so
// this is exactly the session a customer holds when the login-time read fails
// (deploy window) or when the Google callback drops them on the home page.
//
// Account TWO from here on (see EMAIL2), disabled through the API rather than
// the Danger zone so this half also covers a disable that did not come from
// this page.
const token2 = await fetch(`${BACKEND}/auth/customer/emailpass`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL2, password: PASSWORD }),
})
  .then((r) => r.json())
  .then((j) => j.token);
const disabled2 = await fetch(`${BACKEND}/store/customers/me/disable`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-publishable-api-key': PK,
    Authorization: `Bearer ${token2}`,
  },
}).then((r) => r.status);
check(disabled2 === 200, `seed: second account self-disabled (${disabled2})`);
await login(EMAIL2);
await page
  .getByRole('dialog', { name: 'Reactivate account' })
  .waitFor({ state: 'visible', timeout: 30000 });
await page.goto(`${BASE}/settings`, { waitUntil: 'load', timeout: 60000 });
const reactivateBtn = page.getByRole('button', { name: 'Reactivate account' });
check(
  await reactivateBtn.isVisible(),
  'self-disabled: /settings renders and offers Reactivate',
);
check(
  (await page.getByRole('button', { name: 'Disable account' }).count()) === 0,
  'self-disabled: the known-dead Disable button is NOT rendered',
);
check(
  await page.getByRole('button', { name: 'Delete account' }).isVisible(),
  'self-disabled: Delete stays offered (it IS in the carve-out)',
);
await shotDangerZone('4-self-disabled-danger-zone');

await reactivateBtn.click();
const backToDisable = await page
  .getByRole('button', { name: 'Disable account' })
  .waitFor({ state: 'visible', timeout: 30000 })
  .then(
    () => true,
    () => false,
  );
check(backToDisable, 'Reactivate: the panel flips back to Disable/Delete');
check(
  (await page.getByRole('button', { name: 'Reactivate account' }).count()) ===
    0,
  'Reactivate: the Reactivate button is gone once the account is active',
);
const me = await fetch(`${BACKEND}/store/customers/me/account`, {
  headers: {
    'x-publishable-api-key': PK,
    Authorization: `Bearer ${await jwtCookie()}`,
  },
}).then((r) => r.json());
check(
  me?.disabledCause === null,
  `Reactivate: backend reports the account active (got ${JSON.stringify(me?.disabledCause)})`,
);
// The header chip's aria-label is "Top up credits" while the balance is
// unknown and "Balance RM x.xx — top up" once it loads. Its fetch 403'd while
// the account was disabled, so a reactivation that only calls router.refresh()
// leaves it reading "RM —" — the account is back but the header says otherwise.
check(
  await page
    .getByRole('button', { name: /^Balance RM/ })
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(
      () => true,
      () => false,
    ),
  'Reactivate: the header balance re-reads instead of staying "RM —"',
);
await shotDangerZone('5-reactivated');

// ── 4. The rest of the page still works ─────────────────────────────────────
await page.getByLabel('Display name').fill('QA Reactivate');
await page.getByRole('button', { name: 'Save changes' }).click();
check(
  await page
    .getByText('Changes saved.')
    .waitFor({ state: 'visible', timeout: 20000 })
    .then(
      () => true,
      () => false,
    ),
  'profile: name still saves',
);
check(
  // exact: the two consent buttons' labels contain this string too.
  await page.getByText('Analytics cookies', { exact: true }).isVisible(),
  'privacy: cookie settings panel still renders',
);

// The delete confirmation gate, armed and then abandoned — never confirmed.
await page.getByRole('button', { name: 'Delete account' }).click();
const del = page.getByRole('dialog', { name: 'Delete account' });
await del.waitFor({ state: 'visible', timeout: 15000 });
const confirmBtn = del.getByRole('button', { name: 'Delete forever' });
check(await confirmBtn.isDisabled(), 'delete: confirm starts disabled');
await del.getByLabel('Your password').fill(PASSWORD);
await del.getByLabel('Type DELETE to confirm').fill('delete');
check(
  await confirmBtn.isDisabled(),
  'delete: lowercase "delete" does not arm it',
);
await del.getByLabel('Type DELETE to confirm').fill('DELETE');
check(await confirmBtn.isEnabled(), 'delete: password + DELETE arms it');
await shot('6-delete-armed');
await del.getByRole('button', { name: 'Cancel' }).click();
await del.waitFor({ state: 'detached', timeout: 15000 });
check(
  await page.getByRole('button', { name: 'Delete account' }).isVisible(),
  'delete: cancel leaves the account alone',
);

// A failed subresource logs "Failed to load resource" with no URL, which the
// response check below reports properly — count only the rest here.
const scriptErrors = consoleErrors.filter(
  (e) => !/Failed to load resource/.test(e),
);
check(scriptErrors.length === 0, `no console errors (${scriptErrors.length})`);
if (scriptErrors.length) console.log(scriptErrors.slice(0, 5).join('\n'));

// Backend-hosted pack art is excluded: this machine's backend/static holds
// only what was copied into it, while the DB came from a prod clone, so a
// missing /static/ object is a local media gap and not something a code change
// can cause. Everything else is a real failure.
const unexpected = [
  ...new Set(
    badResponses.filter(
      (r) => !decodeURIComponent(r).includes('localhost:9000/static/'),
    ),
  ),
];
check(unexpected.length === 0, `no unexpected non-2xx responses`);
if (unexpected.length) console.log(unexpected.join('\n'));

await b.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
