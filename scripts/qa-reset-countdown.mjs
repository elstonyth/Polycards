// Verifies the challenge hero's reset line ticks (countdown replaces the static
// "Resets Mondays 00:00 (MYT)" label after mount).
//
// NOT wired to the nightly: seed-e2e-fixtures.ts seeds no challenge, so CI's
// /leaderboard has no Resets line and this gate would be red every night
// (plan 120). Wire it only after the CI seed creates an active challenge.
import { chromium } from 'playwright';

const base = process.env.PW_BASE ?? 'http://localhost:4000';
const browser = await chromium.launch();
let first;
let second;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/leaderboard`, { waitUntil: 'networkidle' });
  const line = page.getByText(/^Resets/i).first();
  if ((await line.count()) === 0) {
    console.log(
      'FAIL no "Resets…" line on /leaderboard — no active challenge here; this script needs a seeded, active challenge',
    );
  } else {
    first = (await line.textContent())?.trim();
    await page.waitForTimeout(2200);
    second = (await line.textContent())?.trim();
    console.log(
      JSON.stringify({ first, second, ticking: first !== second }, null, 2),
    );
  }
  await page.screenshot({ path: 'docs/research/reset-countdown.png' });
} finally {
  // A throw anywhere above would otherwise leave a Chromium process behind on
  // an unattended run.
  await browser.close();
}
// Non-zero so this can gate unattended, like the other qa-*.mjs scripts.
process.exitCode = first && second && first !== second ? 0 : 1;
