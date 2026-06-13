// Live-only capture for phygitals (SPA). networkidle never fires on this site,
// so use domcontentloaded + a fixed render wait. Writes live-<w>.png alongside the
// clone shots already in docs/research/audit/shots/<slug>/. Set LIMIT=N to test a few.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const LIVE = 'https://www.phygitals.com';
const OUT = 'docs/research/audit/shots';
const triage = JSON.parse(
  readFileSync('docs/research/audit/triage.json', 'utf8'),
);
const WIDTHS = [
  [390, true],
  [1440, true],
  [3840, false],
];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let livePaths = triage.rows
  .filter((r) => r.bucket === 'diffable')
  .map((r) => r.path);
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT) : 0;
if (LIMIT) livePaths = livePaths.slice(0, LIMIT);

const slug = (p) =>
  p === '/' ? 'home' : p.replace(/^\//, '').replace(/\//g, '_');

async function autoScroll(page) {
  await page
    .evaluate(async () => {
      await new Promise((res) => {
        let t = 0;
        const s = 600;
        const i = setInterval(() => {
          window.scrollBy(0, s);
          t += s;
          if (t >= document.body.scrollHeight + 1200) {
            clearInterval(i);
            res();
          }
        }, 80);
      });
    })
    .catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

const browser = await chromium.launch();
const manifest = [];

async function run(path) {
  const dir = `${OUT}/${slug(path)}`;
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: UA,
  });
  const page = await ctx.newPage();
  const rec = { site: 'live', path, files: {}, errors: [] };
  try {
    await page
      .goto(LIVE + path, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch((e) => rec.errors.push('goto:' + e.message.slice(0, 50)));
    await page.waitForTimeout(8000); // let SPA client-render
    for (const [w, full] of WIDTHS) {
      await page.setViewportSize({ width: w, height: full ? 900 : 2160 });
      await page.waitForTimeout(1500);
      if (full) await autoScroll(page);
      const file = `${dir}/live-${w}.png`;
      await page
        .screenshot({ path: file, fullPage: full })
        .catch(() => rec.errors.push('shot' + w));
      rec.files[w] = file;
    }
  } catch (e) {
    rec.errors.push('fatal:' + String(e.message || e).slice(0, 60));
  } finally {
    await ctx.close();
  }
  manifest.push(rec);
  console.log(
    `live ${path.padEnd(30)} ${rec.errors.length ? 'ERR ' + rec.errors.join('|') : 'ok'}`,
  );
}

const q = [...livePaths];
async function worker() {
  while (q.length) await run(q.shift());
}
await Promise.all([worker(), worker()]);
await browser.close();
writeFileSync(
  'docs/research/audit/manifest-live.json',
  JSON.stringify(manifest, null, 2),
);
console.log('done', manifest.length);
