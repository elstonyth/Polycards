// QA: the pull-history panel (PullHistory.tsx) on the home and pack-detail
// pages — screenshots at phone + desktop widths, then a tab switch to prove
// the tier filter refetches and the rows re-enter.
//
//   pwsh scripts/serve-standalone.ps1 -Port 4000     # after npm run build
//   node scripts/qa-pull-history.mjs [pack-slug]
//
// Screenshots land in docs/research/pull-history-*.png. PW_BASE overrides the
// origin (worktree serves on :4100).
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const SLUG = process.argv[2] ?? 'bronze-pack';
const b = await chromium.launch();

async function shoot(url, label, width, height) {
  const p = await b.newPage({ viewport: { width, height } });
  await p.goto(url, { waitUntil: 'load', timeout: 60_000 });
  const panel = p.locator('[aria-label="Filter pulls by tier"]').first();
  await panel.waitFor({ timeout: 30_000 });
  await panel.scrollIntoViewIfNeeded();
  // Let the entrance stagger settle (12 rows × 45ms + 520ms).
  await p.waitForTimeout(1_400);
  const counters = await p.locator('text=/packs without/').allTextContents();
  const rows = await panel.locator('xpath=..').locator('ol > li').count();
  const out = `docs/research/pull-history-${label}-${width}.png`;
  await panel.locator('xpath=..').screenshot({ path: out });
  console.log(
    `[${label} ${width}] rows=${rows} counters=${JSON.stringify(counters)} -> ${out}`,
  );

  // Tab switch: click the first tier tab, wait for the pending dim to clear
  // (aria-busy=false), count the filtered rows.
  const tab = panel.getByRole('button').nth(1);
  const tabName = (await tab.textContent())?.trim();
  await tab.click();
  const list = panel.locator('xpath=following-sibling::div[1]');
  await p.waitForFunction(
    (el) => el.getAttribute('aria-busy') !== 'true',
    await list.elementHandle(),
    { timeout: 15_000 },
  );
  await p.waitForTimeout(900);
  const filtered = await list.locator('ol > li').count();
  const empty = await list.locator('text=/No .* pulls yet/').count();
  const outTab = `docs/research/pull-history-${label}-${width}-${tabName}.png`;
  await panel.locator('xpath=..').screenshot({ path: outTab });
  console.log(
    `[${label} ${width}] tab=${tabName} rows=${filtered} empty=${empty} -> ${outTab}`,
  );
  await p.close();
}

for (const [w, h] of [
  [390, 844],
  [1440, 900],
]) {
  await shoot(`${BASE}/`, 'home', w, h);
  await shoot(`${BASE}/slots/${SLUG}`, 'pack', w, h);
}
await b.close();

// Stats tab — the gaps chart: header numbers, bars, the reference line.
{
  const b2 = await chromium.launch();
  for (const [w, h] of [
    [390, 844],
    [1440, 900],
  ]) {
    const p = await b2.newPage({ viewport: { width: w, height: h } });
    await p.goto(`${BASE}/slots/${SLUG}`, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    const panel = p.locator('[aria-label="Filter pulls by tier"]').first();
    await panel.waitFor({ timeout: 30_000 });
    await panel.scrollIntoViewIfNeeded();
    await panel.getByRole('button', { name: 'Stats' }).click();
    const chart = panel.locator('xpath=following-sibling::div[1]');
    await chart.locator('ol:not([aria-busy])').waitFor({ timeout: 15_000 });
    await p.waitForTimeout(1_200);
    const header = (await chart.locator('p').first().textContent())?.trim();
    const bars = await chart.locator('ol > li').count();
    const out = `docs/research/pull-history-pack-${w}-stats.png`;
    await panel.locator('xpath=..').screenshot({ path: out });
    console.log(`[stats ${w}] header="${header}" bars=${bars} -> ${out}`);
    await p.close();
  }
  await b2.close();
}
