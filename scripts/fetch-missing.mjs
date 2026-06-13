// Download any local image asset referenced in components that isn't on disk yet.
// (Fixes assets referenced as `${CDN}/path` or plain "/path" literals that the
//  first localize pass missed.)  Run from storefront root: node scripts/fetch-missing.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const COMP = path.join(ROOT, 'src', 'components');
const PUB = path.join(ROOT, 'public');
const files = fs.readdirSync(COMP).filter((f) => f.endsWith('.tsx'));

const refs = new Set();
for (const f of files) {
  const s = fs.readFileSync(path.join(COMP, f), 'utf8');
  // Match any image path, including ones built as `${CDN}/path` template literals.
  for (const m of s.matchAll(/(\/[A-Za-z0-9_\/.-]*\.(?:webp|png|jpg|jpeg))/g)) {
    refs.add(m[1]);
  }
}

const jobs = [];
for (const p of refs) {
  if (
    p.startsWith('/cdn/cards/') ||
    p.startsWith('/fonts/') ||
    p.startsWith('/seo/')
  )
    continue;
  const dest = path.join(PUB, p);
  if (fs.existsSync(dest)) continue; // already have it
  // restore Windows-illegal colon for the remote social filenames
  const remote =
    'https://www.phygitals.com' +
    p.replace(/(\/social\/tweets\/\d+)_media-1\.webp/, '$1:media-1.webp');
  jobs.push({ p, remote, dest });
}

console.log(
  `Referenced image paths: ${refs.size} | missing on disk: ${jobs.length}`,
);

const results = [];
let idx = 0;
async function worker() {
  while (idx < jobs.length) {
    const { p, remote, dest } = jobs[idx++];
    try {
      const res = await fetch(remote, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) {
        results.push({ p, ok: false, status: res.status });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      results.push({ p, ok: true, bytes: buf.length });
    } catch (e) {
      results.push({ p, ok: false, status: String(e) });
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

const ok = results.filter((r) => r.ok);
console.log(`Downloaded ${ok.length}/${jobs.length}`);
for (const r of ok) console.log(`  OK  ${r.p} (${r.bytes}b)`);
const bad = results.filter((r) => !r.ok);
if (bad.length) {
  console.log('FAILED:');
  for (const b of bad) console.log(`  [${b.status}] ${b.p}`);
}
