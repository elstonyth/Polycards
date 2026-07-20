/**
 * Control experiment for the PR #220 investigation.
 *
 * probe-notifications.mjs showed that with `revalidatePath('/notifications')`
 * in markRead, the feed's own history entry disappears (Back from the
 * destination skips /notifications). This isolates the cause: click a row that
 * does NOT fire markRead (an already-read row is a plain <Link>) and compare
 * history.length growth against a row that does.
 *
 * If only the mark-read click fails to push, the server action's revalidation
 * — not the navigation itself — is clobbering the entry.
 *
 * Env: PW_BASE, NOTIF_TOKEN, NOTIF_CUSTOMER, PROBE_LABEL.
 */
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4200';
const TOKEN = process.env.NOTIF_TOKEN;
const CUSTOMER = process.env.NOTIF_CUSTOMER;
const LABEL = process.env.PROBE_LABEL ?? 'unlabelled';
if (!TOKEN || !CUSTOMER)
  throw new Error('NOTIF_TOKEN and NOTIF_CUSTOMER required');

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies([
  { name: '_polycards_jwt', value: TOKEN, domain: 'localhost', path: '/' },
]);
const page = await context.newPage();

const hist = () => page.evaluate(() => history.length);

async function feed() {
  await page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('li', { timeout: 20_000 });
}

/** Rows carrying the sr-only ", unread" marker fire markRead; the rest don't. */
function row(unread) {
  const links = page.locator('li a');
  return unread
    ? links.filter({ has: page.locator('span.sr-only') }).first()
    : links.filter({ hasNot: page.locator('span.sr-only') }).first();
}

async function clickAndReport(unread) {
  const before = await hist();
  const target = row(unread);
  const href = await target.getAttribute('href');
  await target.click();
  await page.waitForURL((u) => u.pathname !== '/notifications', {
    timeout: 20_000,
  });
  await page.waitForTimeout(2500);
  const after = await hist();
  console.log(
    `[${LABEL}] ${unread ? 'UNREAD (fires markRead)' : 'read (plain link)  '} -> ${href} | history.length ${before} -> ${after} | ${after > before ? 'PUSHED' : 'REPLACED (feed entry lost)'}`,
  );
}

try {
  await feed();
  await clickAndReport(false); // control: no server action
  await feed();
  await clickAndReport(true); // subject: markRead + (maybe) revalidatePath
} finally {
  await browser.close();
}
