// One-off QA: demo spin on :4000, assert new SFX files load and no console errors.
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  const audioReqs = new Set();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/sounds/')) audioReqs.add(u.split('/').pop());
  });
  page.on('response', (r) => {
    if (r.url().includes('/sounds/') && r.status() >= 400)
      errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  await page.goto(`${BASE}/slots/bronze-pack/spin?demo=1`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  const spinBtn = page.getByRole('button', { name: /spin/i }).first();
  await spinBtn.waitFor({ state: 'visible', timeout: 15000 });
  await spinBtn.click();
  await page.waitForTimeout(9000); // reels + flood + reveal

  await page.screenshot({ path: 'docs/research/qa-sfx-wiring.png' });
  // Assert every wired sound is actually requested — a removed or misnamed
  // asset must fail the probe, not just shorten the log line.
  const REQUIRED = [
    'slot-tap.mp3',
    'slot-start.mp3',
    'slot-stop.mp3',
    'slot-riser.mp3',
    'slot-win.mp3',
    'slot-bigwin.mp3',
    'slot-count.mp3',
    'slot-ambient.mp3',
  ];
  for (const f of REQUIRED) {
    if (!audioReqs.has(f)) errors.push(`missing sound request: ${f}`);
  }
  console.log(
    'audio files requested:',
    [...audioReqs].sort().join(', ') || 'NONE',
  );
  console.log('console errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length) process.exit(1);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
