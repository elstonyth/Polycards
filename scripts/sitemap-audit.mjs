// Enumerate DISTINCT route patterns (page types) from phygitals.com's sitemap index,
// so we can audit clone coverage by template — not by every data-instance URL.
const UA = { headers: { 'User-Agent': 'Mozilla/5.0' } };
const locs = (xml) =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

// Collapse a path into a route "shape": dynamic-looking segments → [param].
function shape(path) {
  const parts = path.split('/').filter(Boolean);
  return (
    '/' +
    parts
      .map((seg) => {
        if (/^\d+$/.test(seg)) return '[n]';
        // long ids / base58-ish / uuid / >20 chars / mixed-case hash
        if (
          seg.length > 20 ||
          (/[A-Z]/.test(seg) && /[a-z]/.test(seg) && /\d/.test(seg))
        )
          return '[id]';
        if (/^[0-9a-f]{8,}$/i.test(seg)) return '[id]';
        return seg;
      })
      .join('/')
  );
}

const idx = await fetch('https://phygitals.com/sitemap.xml', UA).then((r) =>
  r.text(),
);
const subs = locs(idx);
console.log(`sitemap index → ${subs.length} sub-sitemaps`);

const patterns = new Map(); // shape -> {count, example}
let total = 0;

async function processSub(url) {
  try {
    const xml = await fetch(url, UA).then((r) => r.text());
    for (const u of locs(xml)) {
      total++;
      const path = u.replace(/^https?:\/\/[^/]+/, '') || '/';
      // shape using only the first 3 segments (enough to distinguish templates)
      const segs = path.split('/').filter(Boolean).slice(0, 3).join('/');
      const sh = shape('/' + segs);
      const cur = patterns.get(sh);
      if (cur) cur.count++;
      else patterns.set(sh, { count: 1, example: path.slice(0, 70) });
    }
  } catch (e) {
    console.log('FAIL', url, e.message);
  }
}

// limited concurrency
for (let i = 0; i < subs.length; i += 6) {
  await Promise.all(subs.slice(i, i + 6).map(processSub));
}

console.log(`total URLs: ${total}\n`);
const sorted = [...patterns.entries()].sort((a, b) => b[1].count - a[1].count);
console.log('DISTINCT ROUTE PATTERNS (page types):');
for (const [sh, info] of sorted) {
  console.log(
    `  ${String(info.count).padStart(7)}  ${sh.padEnd(34)} e.g. ${info.example}`,
  );
}
