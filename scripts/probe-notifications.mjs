/**
 * PR #220 notification read-path repro harness.
 *
 * Multi-hop measurement of the /notifications feed across BOTH return paths:
 *   hop 1: click unread row -> /vip -> return via the header bell (soft nav)
 *   hop 2: click unread row -> /vip -> return via browser BACK (history restore)
 *
 * Isolation (the trap that invalidated the previous attempt): a fresh Playwright
 * context = its own cookie jar, and the JWT is injected directly rather than
 * driven through the shared login UI. `/api/me` is asserted through the SAME
 * browser context before and after every measurement; a change aborts the run.
 *
 * Env: PW_BASE (storefront), NOTIF_TOKEN (customer JWT), NOTIF_CUSTOMER (cus_...),
 *      PROBE_LABEL (free text recorded in the output), PROBE_OUT (json path).
 *
 * Fixture (a fresh customer per run — read state is one-way, so a run cannot be
 * repeated against the same customer):
 *   1. register + login a throwaway customer against :9000 (see
 *      tests/e2e/helpers/api.ts createCustomer) and keep its JWT;
 *   2. create ~9 'feed' notifications for it via a `medusa exec` script calling
 *      notifyFeed() (backend/packages/api/src/modules/packs/notify-feed.ts);
 *   3. POST /store/notifications/:id/read for all but two, leaving 2 unread.
 * The JWT goes straight into the `_polycards_jwt` cookie — no login UI needed.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = process.env.PW_BASE ?? 'http://localhost:4200';
const BACKEND = process.env.PW_BACKEND ?? 'http://localhost:9000';
// No default: the storefront's publishable key already lives in
// tests/e2e/helpers/constants.ts — don't mint a second copy in the repo.
const PK = process.env.PW_PK;
if (!PK) throw new Error('PW_PK required (see tests/e2e/helpers/constants.ts)');
const TOKEN = process.env.NOTIF_TOKEN;
const CUSTOMER = process.env.NOTIF_CUSTOMER;
const LABEL = process.env.PROBE_LABEL ?? 'unlabelled';
const OUT = process.env.PROBE_OUT ?? `probe-${LABEL}.json`;
if (!TOKEN || !CUSTOMER)
  throw new Error('NOTIF_TOKEN and NOTIF_CUSTOMER required');

const log = [];
const note = (m) => {
  console.log(m);
  log.push(m);
};

/** Identity through the browser's own cookie jar — a Node fetch would see no cookie. */
async function whoami(page) {
  const res = await page.request.get(`${BASE}/api/me`);
  const body = await res.json();
  return body.customer?.id ?? null;
}

async function assertIdentity(page, where) {
  let id = await whoami(page);
  // A DIFFERENT customer is contamination — abort immediately, that is the trap
  // this harness exists to catch. `null` is a transient backend auth hiccup
  // (the retrieve is rate-limited); retry a couple of times before giving up.
  for (let i = 0; id === null && i < 3; i++) {
    await page.waitForTimeout(3000);
    id = await whoami(page);
  }
  if (id !== CUSTOMER) {
    throw new Error(
      `IDENTITY DRIFT at ${where}: expected ${CUSTOMER}, got ${id} — run invalid`,
    );
  }
  return id;
}

/**
 * Row state is server-rendered and synchronous TODAY, but a client re-sync fix
 * would correct it asynchronously — so poll to settle like the bell read, and
 * record both the first and the settled value. Reading once would score such a
 * fix as a failure.
 */
async function readRows(page) {
  const get = () =>
    page.evaluate(() => {
      const marks = [...document.querySelectorAll('span.sr-only')].filter((s) =>
        (s.textContent ?? '').trim().startsWith(', unread'),
      );
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /Mark all read \(\d+\)/.test(b.textContent ?? ''),
      );
      return {
        unreadRows: marks.length,
        totalRows: document.querySelectorAll('li').length,
        markAllLabel: btn ? btn.textContent.trim() : null,
      };
    });
  const first = await get();
  let prev = JSON.stringify(first);
  let settled = first;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400);
    const now = await get();
    settled = now;
    if (JSON.stringify(now) === prev) break;
    prev = JSON.stringify(now);
  }
  return { rowsFirst: first, ...settled };
}

/**
 * The bell count arrives from an async server action, so an immediate read can
 * capture the pre-resolve value. Record both the first read and the settled one.
 */
async function readBell(page) {
  const get = () =>
    page.evaluate(() => {
      const a = document.querySelector('a[aria-label^="Notifications"]');
      return a ? a.getAttribute('aria-label') : null;
    });
  const first = await get();
  let prev = first;
  let settled = first;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400);
    const now = await get();
    if (now === prev) {
      settled = now;
      break;
    }
    prev = now;
    settled = now;
  }
  return { first, settled };
}

async function measure(page, step) {
  await assertIdentity(page, `${step}:before`);
  const rows = await readRows(page);
  const bell = await readBell(page);
  await assertIdentity(page, `${step}:after`);
  const m = { step, url: new URL(page.url()).pathname, ...rows, bell };
  note(
    `[${step}] ${m.url} | unreadRows=${m.unreadRows} | markAll=${m.markAllLabel} | bellFirst=${bell.first} | bellSettled=${bell.settled}`,
  );
  return m;
}

async function gotoFeed(page) {
  await page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('li', { timeout: 20_000 });
}

/** Click the newest unread row (a link carrying the sr-only ", unread" marker). */
async function clickFirstUnread(page) {
  const row = page
    .locator('li a')
    .filter({ has: page.locator('span.sr-only') })
    .first();
  await row.waitFor({ timeout: 15_000 });
  const href = await row.getAttribute('href');
  await row.click();
  await page.waitForURL((u) => u.pathname !== '/notifications', {
    timeout: 20_000,
  });
  // Dwell like a real user: let the destination settle and the in-flight
  // markRead server action land before we navigate back.
  await page.waitForTimeout(2500);
  const len = await page.evaluate(() => history.length);
  note(
    `  clicked unread row -> ${href} (now ${new URL(page.url()).pathname}, history.length=${len})`,
  );
}

async function backViaBell(page) {
  await page.locator('a[aria-label^="Notifications"]').first().click();
  await page.waitForURL((u) => u.pathname === '/notifications', {
    timeout: 20_000,
  });
  await page.waitForSelector('li', { timeout: 20_000 });
  const len = await page.evaluate(() => history.length);
  note(`  returned via bell (history.length=${len})`);
}

async function backViaHistory(page) {
  // Drive the real Back button in-page: Playwright's goBack() races App Router
  // same-document history transitions. /vip may also push an entry of its own,
  // so step back until the feed is the current entry.
  for (let i = 0; i < 5; i++) {
    const len = await page.evaluate(() => history.length);
    await page.evaluate(() => history.back());
    await page.waitForTimeout(1200);
    const here = new URL(page.url()).pathname;
    note(`  back-button step ${i + 1}: history.length=${len} -> ${here}`);
    if (here === '/notifications') {
      await page.waitForSelector('li', { timeout: 20_000 });
      return;
    }
  }
  throw new Error('back-button never reached /notifications');
}

async function backendFeed() {
  const res = await fetch(`${BACKEND}/store/notifications`, {
    headers: {
      'x-publishable-api-key': PK,
      Authorization: `Bearer ${TOKEN}`,
    },
  });
  const body = await res.json();
  return {
    unread_count: body.unread_count,
    unread: body.notifications.filter((n) => !n.read_at).map((n) => n.id),
  };
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addCookies([
  { name: '_polycards_jwt', value: TOKEN, domain: 'localhost', path: '/' },
]);
const page = await context.newPage();

const steps = [];
let error = null;
try {
  note(`=== probe "${LABEL}" against ${BASE} as ${CUSTOMER} ===`);
  note(`backend before: ${JSON.stringify(await backendFeed())}`);

  await gotoFeed(page);
  steps.push(await measure(page, 'S0-initial-load'));

  await clickFirstUnread(page);
  await backViaBell(page);
  steps.push(await measure(page, 'S1-return-via-bell'));
  note(`  backend after hop1: ${JSON.stringify(await backendFeed())}`);

  await clickFirstUnread(page);
  await backViaHistory(page);
  steps.push(await measure(page, 'S2-return-via-back-button'));
  note(`  backend after hop2: ${JSON.stringify(await backendFeed())}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('li', { timeout: 20_000 });
  steps.push(await measure(page, 'S3-hard-reload-ground-truth'));

  note(`backend final: ${JSON.stringify(await backendFeed())}`);
} catch (e) {
  error = String(e?.message ?? e);
  note(`ERROR: ${error}`);
} finally {
  await browser.close();
}

writeFileSync(
  OUT,
  JSON.stringify(
    { label: LABEL, base: BASE, customer: CUSTOMER, steps, error, log },
    null,
    2,
  ),
);
note(`wrote ${OUT}`);
if (error) process.exitCode = 1;
