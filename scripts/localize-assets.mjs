// Localize all hotlinked phygitals.com image assets into public/, then rewrite
// the component sources to reference the local copies.
//
//  - https://www.phygitals.com/<path>            -> /<path>            (download to public/<path>)
//  - RecentPulls cardImg(id) (Cloudflare resize) -> /cdn/cards/<id>.webp
//  - ":" in social filenames is sanitized to "_" (Windows-illegal in paths)
//
// Run from the storefront root: node scripts/localize-assets.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const COMP = path.join(ROOT, 'src', 'components');
const PUB = path.join(ROOT, 'public');
const WWW = 'https://www.phygitals.com';

const sanitize = (p) => p.replace(/:/g, '_');
const files = fs.readdirSync(COMP).filter((f) => f.endsWith('.tsx'));

// ---- 1. Gather download jobs from ORIGINAL sources -------------------------
const jobs = new Map(); // url -> absolute dest path

for (const f of files) {
  const s = fs.readFileSync(path.join(COMP, f), 'utf8');
  const re = /https:\/\/www\.phygitals\.com(\/[^"'`\s)]*)/g;
  let m;
  while ((m = re.exec(s))) {
    const p = m[1];
    if (p.startsWith('/cdn-cgi/')) continue; // resize wrapper handled below
    jobs.set(WWW + p, path.join(PUB, sanitize(p)));
  }
}

// RecentPulls dynamic card images (download the resized webp the browser loads)
const rp = fs.readFileSync(path.join(COMP, 'RecentPullsSection.tsx'), 'utf8');
const cardIds = [...rp.matchAll(/cardImg\('([^']+)'\)/g)].map((m) => m[1]);
const localCard = (id) => `/cdn/cards/${id.replace(/[^\w.-]/g, '_')}.webp`;
for (const id of cardIds) {
  const url = `${WWW}/cdn-cgi/image/width=512,quality=85,format=auto,fit=scale-down/https://img.phygitals.com/${id}`;
  jobs.set(url, path.join(PUB, sanitize(localCard(id))));
}

// ---- 2. Download (small concurrency pool) ----------------------------------
const entries = [...jobs.entries()];
const results = [];
const CONCURRENCY = 6;
let idx = 0;

async function worker() {
  while (idx < entries.length) {
    const [url, dest] = entries[idx++];
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) {
        results.push({ url, dest, ok: false, status: res.status });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      results.push({ url, dest, ok: true, bytes: buf.length });
    } catch (e) {
      results.push({ url, dest, ok: false, status: String(e) });
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ---- 3. Rewrite component sources to local paths ---------------------------
for (const f of files) {
  const fp = path.join(COMP, f);
  let s = fs.readFileSync(fp, 'utf8');
  const before = s;
  if (f === 'RecentPullsSection.tsx') {
    // Replace the cardImg helper body to point at the localized files.
    s = s.replace(
      /const cardImg = \(id: string\) =>[\s\S]*?;\n/,
      'const cardImg = (id: string) => `/cdn/cards/${id.replace(/[^\\w.-]/g, "_")}.webp`;\n',
    );
  }
  // Strip the host (CDN consts become "", full URLs become /path)
  s = s.replaceAll('https://www.phygitals.com', '');
  // Sanitize Windows-illegal colon in localized social filenames
  s = s.replaceAll(':media-1.webp', '_media-1.webp');
  if (s !== before) fs.writeFileSync(fp, s);
}

// ---- 4. Report -------------------------------------------------------------
const ok = results.filter((r) => r.ok);
const bad = results.filter((r) => !r.ok);
console.log(`Downloaded ${ok.length}/${results.length} assets to public/`);
console.log(`Card images: ${cardIds.length}`);
if (bad.length) {
  console.log('\nFAILED:');
  for (const b of bad) console.log(`  [${b.status}] ${b.url}`);
}
