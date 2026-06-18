// qa-slots-config.mjs — verify the lean /slots configurator (Phase A′ Task 4).
// Asserts pack tiles render, each Play link targets /slots/<id>?count=<n>, no
// console errors, no broken images. Screenshot → docs/research/pw-slots-config.png
// (gitignored). Run AFTER booting the prod standalone on :4000 (see CLAUDE.md).
//   node scripts/qa-slots-config.mjs
import { chromium } from 'playwright';

const URL = process.env.SLOTS_URL ?? 'http://localhost:4000/slots';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
p.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

await p.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForTimeout(600);

const result = await p.evaluate(() => {
  const playLinks = [...document.querySelectorAll('a[href^="/slots/"]')].map(
    (a) => a.getAttribute('href'),
  );
  const steppers = document.querySelectorAll(
    '[aria-label="Increase quantity"]',
  ).length;
  const brokenImages = [...document.images]
    .filter((i) => i.complete && i.naturalWidth === 0)
    .map((i) => i.getAttribute('src'));
  const h1 = document.querySelector('h1')?.textContent?.trim() ?? null;
  return {
    h1,
    playLinks,
    playWithCount: playLinks.filter((h) => /\?count=\d+/.test(h)).length,
    steppers,
    brokenImages,
  };
});

await p.screenshot({
  path: 'docs/research/pw-slots-config.png',
  fullPage: true,
});
await b.close();

const fail = [];
if (!result.playLinks.length && !result.steppers)
  fail.push('no pack tiles rendered (no Play links or steppers found)');
if (result.playLinks.length && result.playWithCount === 0)
  fail.push('Play links present but none carry ?count=N');
if (result.brokenImages.length)
  fail.push(`broken images: ${result.brokenImages.join(', ')}`);
if (consoleErrors.length)
  fail.push(`console errors: ${consoleErrors.join(' | ')}`);

console.log(JSON.stringify({ ...result, consoleErrors, fail }, null, 2));
if (fail.length) {
  console.error('\nQA FAILED:\n- ' + fail.join('\n- '));
  process.exit(1);
}
console.log(
  '\nQA PASSED: /slots configurator renders with ?count= Play links.',
);
