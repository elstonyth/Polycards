// QA capture of the check-in top-up bar (owner 2026-11-20): check-in rewards
// wait until the week's top-ups reach RM 50. Seeds the session cookie directly
// (PW_JWT), like qa-task-hub-v2.mjs, so it runs against any backend that
// answers /store/tasks for that token.
// Usage:
//   PW_BASE=http://localhost:4150 PW_JWT=<customer jwt> node scripts/qa-checkin-topup-gate.mjs locked
//   ...then top the account up RM 50 on that backend's DB, and:
//   PW_BASE=http://localhost:4150 PW_JWT=<customer jwt> node scripts/qa-checkin-topup-gate.mjs unlocked
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4150';
const JWT = process.env.PW_JWT ?? 'preview';
const OUT = process.env.PW_OUT ?? 'docs/research';
const STAGE = process.argv[2] ?? 'locked';

const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL ?? 'chrome',
  args: ['--mute-audio'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
const { hostname } = new URL(BASE);
await ctx.addCookies([
  { name: '_polycards_jwt', value: JWT, domain: hostname, path: '/' },
]);
const page = await ctx.newPage();
await page.goto(`${BASE}/task`, { waitUntil: 'load' });
for (const name of [/reject/i, /dismiss telegram banner/i]) {
  const b = page.getByRole('button', { name });
  if (await b.count())
    await b
      .first()
      .click()
      .catch(() => {});
}
const track = page.locator('section[aria-labelledby="checkin-heading"]');
await track.waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);
const shot = async (file) => {
  await track.scrollIntoViewIfNeeded();
  await track.screenshot({ path: `${OUT}/checkin-gate-${file}.png` });
};
const notice = () =>
  page
    .locator('p[aria-live="polite"]')
    .first()
    .innerText()
    .catch(() => '');
const slot = (day) =>
  track.getByRole('button', { name: new RegExp(`^Day ${day} reward`) });

const report = {};
if (STAGE === 'partial') {
  // Some topped up, short of the bar: the ask shrinks to what is left.
  await shot('partial');
  report.bar = await track.locator('div.rounded-xl p').first().innerText();
  report.progress = await track
    .getByRole('progressbar', { name: /topped up this week/i })
    .getAttribute('aria-valuetext');
  await slot(2).click({ force: true });
  await page.waitForTimeout(800);
  report.tapDay2 = await notice();
} else if (STAGE === 'locked') {
  await shot('1-locked');
  report.line = await track.locator('p.mt-3.text-xs').first().innerText();
  // Checking in still works while the rewards wait.
  const checkIn = track.getByRole('button', { name: /^Check in · Day/ });
  report.checkInButton = await checkIn.innerText();
  await checkIn.click();
  await page.waitForTimeout(2500);
  report.afterCheckIn = await notice();
  report.checkInButtonAfter = await track
    .getByRole('button', { name: /checked in today/i })
    .innerText()
    .catch(() => 'missing');
  await shot('2-checked-in-still-locked');
  // A tap on an earned slot explains the wait instead of claiming.
  await slot(2).click({ force: true });
  await page.waitForTimeout(800);
  report.tapDay2 = await notice();
  report.day2Label = await slot(2).getAttribute('aria-label');
  await shot('3-tap-locked-slot');
  // The bar's Top up button opens the top-up sheet.
  await track.getByRole('button', { name: /^top up$/i }).click();
  await page.waitForTimeout(1500);
  report.topUpDialog = await page
    .getByRole('dialog')
    .first()
    .isVisible()
    .catch(() => false);
  await page.screenshot({ path: `${OUT}/checkin-gate-4-topup-sheet.png` });
} else {
  await shot('5-unlocked');
  report.line = await track.locator('p.mt-3.text-xs').first().innerText();
  report.barGone =
    (await track.getByRole('button', { name: /^top up$/i }).count()) === 0;
  report.day2Label = await slot(2).getAttribute('aria-label');
  await slot(2).click({ force: true });
  await page.waitForTimeout(3000);
  report.claimDay2 = await notice();
  await page.waitForTimeout(1500);
  await shot('6-day2-claimed');
  report.day2LabelAfter = await slot(2).getAttribute('aria-label');
}
console.log(JSON.stringify(report, null, 2));
await browser.close();
