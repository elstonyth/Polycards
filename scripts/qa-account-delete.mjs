// Browser verification for the Settings Danger zone: the delete confirmation
// gate, and the negative control that no customer-facing DISABLE survives.
//
//   npm run build && pwsh scripts/serve-standalone.ps1 -Port 4100   (background)
//   corepack yarn dev  (from backend/packages/api — health at :9000/health)
//   node scripts/qa-account-delete.mjs [storefront-port] [backend-port]
//
// This exists because neither the gate nor the panel can be covered by the test
// suites: vitest collects `src/**/*.test.ts` only, and DangerZone.tsx is a
// `.tsx`. `deleteConfirmReady` is unit-tested; whether the button is actually
// WIRED to it is knowable only here.
//
// Deliberately stops at the armed button and cancels. Confirming would delete
// the account, and the purge itself is covered end-to-end by the backend http
// spec (account-self-service.spec.ts) against a real database.
//
// Screenshots to docs/research/qa-account-delete-*.png.
import { chromium } from 'playwright';

process.loadEnvFile('.env.local');
const BASE = `http://localhost:${process.argv[2] || '4100'}`;
const BACKEND = `http://localhost:${process.argv[3] || '9000'}`;
// Read, never printed — this is a live key.
const PK = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY;
const EMAIL = `qa-delete-${Date.now()}@test.dev`;
const PASSWORD = 'DeleteQA12345!';

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
  page.screenshot({ path: `docs/research/qa-account-delete-${name}.png` });

/** The Danger zone sits below the fold — an unscrolled shot proves nothing. */
const shotDangerZone = async (name) => {
  await page
    .getByRole('button', { name: 'Delete account' })
    .scrollIntoViewIfNeeded();
  await shot(name);
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

check(Boolean(await seed(EMAIL)), 'seed: customer created');

await page.goto(`${BASE}/?auth=login`, { waitUntil: 'load', timeout: 60000 });
await page.getByPlaceholder('Email').fill(EMAIL);
await page.getByPlaceholder('Password', { exact: true }).fill(PASSWORD);
await page.getByRole('button', { name: 'Log in', exact: true }).click();
await page
  .getByRole('dialog', { name: 'Log in' })
  .waitFor({ state: 'detached', timeout: 30000 });

await page.goto(`${BASE}/settings`, { waitUntil: 'load', timeout: 60000 });
// waitFor, not isVisible(): the latter does not wait, and /settings is
// force-dynamic, so an immediate read races the panel onto the page and reports
// a button that is simply not there YET as missing.
check(
  await page
    .getByRole('button', { name: 'Delete account' })
    .waitFor({ state: 'visible', timeout: 20000 })
    .then(
      () => true,
      () => false,
    ),
  'Danger zone offers Delete',
);
// The negative control for this change: disabling is an ADMIN action now, so
// no customer-facing Disable or Reactivate may survive anywhere on this panel.
check(
  (await page.getByRole('button', { name: 'Disable account' }).count()) === 0,
  'Danger zone does NOT offer Disable',
);
check(
  (await page.getByRole('button', { name: 'Reactivate account' }).count()) ===
    0,
  'Danger zone does NOT offer Reactivate',
);
await shotDangerZone('1-danger-zone');

// The confirmation gate, armed and then abandoned — never confirmed.
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
await shot('2-delete-armed');
await del.getByRole('button', { name: 'Cancel' }).click();
await del.waitFor({ state: 'detached', timeout: 15000 });
check(
  await page.getByRole('button', { name: 'Delete account' }).isVisible(),
  'delete: cancel leaves the account alone',
);

// The rest of the page still works.
await page.getByLabel('Display name').fill('QA Delete');
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
