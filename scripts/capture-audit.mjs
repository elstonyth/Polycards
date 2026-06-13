// Single bounded capture pass for the route audit.
// Reads docs/research/audit/triage.json, screenshots clone (:4000) for every rendering
// route and live phygitals for the diffable bucket. Writes PNGs + manifest.json to disk.
// Diff sub-agents READ these PNGs; they do NOT launch browsers.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const CLONE = 'http://localhost:4000';
const LIVE = 'https://www.phygitals.com';
const OUT = 'docs/research/audit/shots';
mkdirSync(OUT, { recursive: true });

const triage = JSON.parse(
  readFileSync('docs/research/audit/triage.json', 'utf8'),
);

// width set: [w, fullPage?] — 4K viewport-only to cap token cost
const WIDTHS = [
  [390, true],
  [1440, true],
  [3840, false],
];

const clonePaths = triage.rows
  .filter((r) => r.clone === 200)
  .map((r) => r.path);
if (!clonePaths.includes('/claw/pokemon-mythic'))
  clonePaths.push('/claw/pokemon-mythic');
const livePaths = triage.rows
  .filter((r) => r.bucket === 'diffable')
  .map((r) => r.path);

const slug = (p) =>
  p === '/' ? 'home' : p.replace(/^\//, '').replace(/\//g, '_');

const jobs = [];
for (const p of clonePaths) jobs.push({ site: 'clone', base: CLONE, path: p });
for (const p of livePaths) jobs.push({ site: 'live', base: LIVE, path: p });

async function autoScroll(page) {
  await page
    .evaluate(async () => {
      await new Promise((res) => {
        let total = 0;
        const step = 600;
        const t = setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          if (total >= document.body.scrollHeight + 1200) {
            clearInterval(t);
            res();
          }
        }, 80);
      });
    })
    .catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

const manifest = [];
const browser = await chromium.launch();

async function runJob(job) {
  const dir = `${OUT}/${slug(job.path)}`;
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const rec = { site: job.site, path: job.path, files: {}, errors: [] };
  try {
    await page
      .goto(job.base + job.path, { waitUntil: 'networkidle', timeout: 45000 })
      .catch((e) => rec.errors.push('goto:' + e.message.slice(0, 60)));
    await page.waitForTimeout(1200);
    for (const [w, full] of WIDTHS) {
      await page.setViewportSize({ width: w, height: full ? 900 : 2160 });
      await page.waitForTimeout(400);
      if (full) await autoScroll(page);
      const file = `${dir}/${job.site}-${w}.png`;
      await page
        .screenshot({ path: file, fullPage: full })
        .catch((e) => rec.errors.push(`shot${w}:` + e.message.slice(0, 50)));
      rec.files[w] = file;
    }
  } catch (e) {
    rec.errors.push('fatal:' + String(e.message || e).slice(0, 80));
  } finally {
    await ctx.close();
  }
  manifest.push(rec);
  console.log(
    `${job.site.padEnd(5)} ${job.path.padEnd(34)} ${rec.errors.length ? 'ERR ' + rec.errors.join('|') : 'ok'}`,
  );
}

const queue = [...jobs]; // bounded concurrency = 2
async function worker() {
  while (queue.length) await runJob(queue.shift());
}
await Promise.all([worker(), worker()]);

await browser.close();
writeFileSync(
  'docs/research/audit/manifest.json',
  JSON.stringify(manifest, null, 2),
);
console.log(
  `\nCaptured ${manifest.length} routes. Manifest → docs/research/audit/manifest.json`,
);
