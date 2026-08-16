// QA for the asset-shrink pass: prove the re-encoded 720p heroes and the
// recompressed images still load, and report what each page actually pulls
// over the wire (the number that matters, not the number on disk).
//
//   node scripts/qa-shrunk-assets.mjs [--base http://localhost:4000]
import { chromium } from 'playwright';
import { mkdir, glob } from 'node:fs/promises';
import { basename } from 'node:path';

const baseArg = process.argv[process.argv.indexOf('--base') + 1];
const base = baseArg?.startsWith('http') ? baseArg : 'http://localhost:4000';

/** What scripts/shrink-videos.mjs targets. Asserted, not just reported. */
const EXPECT_DIMS = '1280x720';

const OUT = 'docs/research/shrink';
await mkdir(OUT, { recursive: true });

const PAGES = [
  { name: 'home', path: '/', hero: 'shop-night' },
  { name: 'pack-detail', path: '/slots/bronze-pack', hero: 'bronze-factory' },
];

const browser = await chromium.launch();
let failed = false;

for (const { name, path, hero } of PAGES) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  /**
   * url -> transferred bytes, so media and images can be totalled separately.
   * Read from `content-length`, which is absent on chunked responses and on
   * 304s — so these totals are floors for eyeballing, not measurements. The
   * decode pass below is what actually gates.
   */
  const media = new Map();
  const images = new Map();
  const failures = [];

  page.on('response', async (res) => {
    const url = res.url();
    if (res.status() >= 400) failures.push(`${res.status()} ${url}`);
    const type = res.headers()['content-type'] ?? '';
    const len = Number(res.headers()['content-length'] ?? 0);
    if (!len) return;
    if (type.startsWith('video/')) media.set(url, len);
    else if (type.startsWith('image/')) images.set(url, len);
  });

  await page.goto(`${base}${path}`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  // The heroes sit below the fold and only fetch once scrolled into view, so a
  // top-of-page load reports zero video bytes even when everything is fine.
  // Scroll the <video>, NOT the <source> that identifies it: <source> is a
  // metadata element with no box, so scrollIntoViewIfNeeded on it cannot move
  // the viewport — and the .catch() below would swallow that into a silent
  // no-op. `:has()` selects the parent from the child.
  const heroEl = page.locator(`video:has(source[src*="${hero}"])`).first();
  if (await heroEl.count()) {
    await heroEl.scrollIntoViewIfNeeded().catch(() => {});
  }
  // Autoplaying heroes stream in after networkidle fires; give the loop a beat
  // so the video bytes land in the tally rather than being missed entirely.
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });

  // readyState >= 2 means the browser decoded at least the current frame — the
  // check that a re-encode actually plays, not merely that bytes were served.
  const decoded = await page.evaluate(() =>
    [...document.querySelectorAll('video')].map((v) => ({
      src: v.currentSrc.split('/').pop(),
      readyState: v.readyState,
      dims: `${v.videoWidth}x${v.videoHeight}`,
    })),
  );
  console.log(`  <video> decoded: ${JSON.stringify(decoded)}`);

  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const kb = (n) => Math.round(n / 1024);
  const heroHit = [...media.keys()].some((u) => u.includes(hero));

  console.log(`\n${name}  (${path})`);
  console.log(`  video  ${media.size} req  ${kb(sum(media))}KB`);
  for (const [u, n] of media)
    console.log(`    ${kb(n)}KB  ${u.replace(base, '')}`);
  console.log(`  images ${images.size} req  ${kb(sum(images))}KB`);
  // Informational, not a gate: both heroes only mount once the backend returns
  // pack data, so "no" here means Medusa is down just as often as it means the
  // asset broke. The decode pass below is the gate that tells them apart.
  console.log(
    `  hero "${hero}" loaded: ${heroHit ? 'yes' : 'no (backend down? see decode check)'}`,
  );
  if (failures.length)
    console.log(`  FAILED REQUESTS:\n    ${failures.join('\n    ')}`);

  if (failures.length) failed = true;
  await ctx.close();
}

// The heroes only mount once the backend returns pack data, so a storefront
// served without Medusa renders the empty state and no <video> at all. Decode
// is the real risk in a re-encode (ffmpeg happily writes files a browser
// refuses), so test it directly against the served files instead of requiring
// the whole stack to be up.
// Discovered from disk rather than listed here, so a seventh tier cannot ship
// unverified — and so this does not restate FACTORY_VIDEO_TIERS in
// src/lib/packs-data.ts, which would then drift. Mirrors the directories
// scripts/shrink-videos.mjs walks; every clip is expected to have both
// containers, which is itself part of what this asserts.
const CLIPS = (
  await Array.fromAsync(glob('public/{images/polycards,videos}/*.{webm,mp4}'))
)
  .map((p) => p.replaceAll('\\', '/').replace(/\.(webm|mp4)$/, ''))
  .map((p) => p.replace(/^public/, ''))
  .filter((p, i, all) => all.indexOf(p) === i)
  .sort();
if (!CLIPS.length) {
  console.error('no clips found under public/ — wrong cwd?');
  process.exit(1);
}

const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

console.log(
  `\ndecode check — ${CLIPS.length} clips, expecting ${EXPECT_DIMS} (readyState>=2 means a frame decoded)`,
);
for (const clip of CLIPS) {
  for (const ext of ['webm', 'mp4']) {
    // CLIPS already carries the served path minus the extension.
    const src = `${clip}.${ext}`;
    const r = await page.evaluate(
      ([url]) =>
        new Promise((resolve) => {
          const v = document.createElement('video');
          v.muted = true;
          v.preload = 'auto';
          v.src = url;
          const done = (err) =>
            resolve({
              readyState: v.readyState,
              dims: `${v.videoWidth}x${v.videoHeight}`,
              err,
            });
          v.onloadeddata = () => done(null);
          v.onerror = () => done(v.error?.message ?? 'load error');
          setTimeout(() => done('timeout'), 15000);
        }),
      [src],
    );
    // Assert the dimensions, do not merely print them. Decoding proves the file
    // is playable; only this catches a re-encode that landed at the wrong size —
    // a regressed skip-guard leaving 1920x1080, or a bad -vf giving 640x360.
    // Catching that is the whole reason this script exists.
    const ok = !r.err && r.readyState >= 2 && r.dims === EXPECT_DIMS;
    if (!ok) failed = true;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${src.padEnd(44)} readyState=${r.readyState} ${r.dims}${r.err ? ` (${r.err})` : ''}`,
    );
  }
}
await ctx.close();

await browser.close();
console.log(`\nscreenshots -> ${OUT}/`);
process.exit(failed ? 1 : 0);
