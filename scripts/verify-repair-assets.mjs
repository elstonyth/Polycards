// Validate every downloaded image for truncation/corruption and re-download any
// bad ones with Node fetch (reliable, unlike the curl loop that hit cygwin fork
// errors). Run from storefront root: node scripts/verify-repair-assets.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PUB = path.join(ROOT, 'public');
const COMP = path.join(ROOT, 'src', 'components');

// Collect every image path referenced by components (local "/..." paths).
const refs = new Set();
for (const f of fs.readdirSync(COMP).filter((f) => f.endsWith('.tsx'))) {
  const s = fs.readFileSync(path.join(COMP, f), 'utf8');
  for (const m of s.matchAll(/(\/[A-Za-z0-9_\/.-]*\.(?:webp|png|jpg|jpeg))/g))
    refs.add(m[1]);
}

// Map a local public path back to its source URL on phygitals.com.
function remoteFor(p) {
  if (p.startsWith('/cdn/cards/')) {
    const id = p.slice('/cdn/cards/'.length).replace(/\.webp$/, '');
    return `https://www.phygitals.com/cdn-cgi/image/width=512,quality=85,format=auto,fit=scale-down/https://img.phygitals.com/${id}`;
  }
  // restore Windows-illegal colon in social tweet media filenames
  return (
    'https://www.phygitals.com' +
    p.replace(/(\/social\/tweets\/\d+)_media-1\.webp/, '$1:media-1.webp')
  );
}

// Validate a WebP file: RIFF....WEBP header + declared size matches file size.
function webpStatus(buf) {
  if (buf.length < 12) return 'too-small';
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return 'no-RIFF';
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return 'no-WEBP';
  const declared = buf.readUInt32LE(4) + 8; // total file size per RIFF header
  if (buf.length < declared) return `truncated (${buf.length}/${declared})`;
  return 'ok';
}
function pngStatus(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig))
    return 'bad-png-header';
  // IEND chunk must terminate a complete PNG
  if (buf.subarray(buf.length - 8).toString('ascii', 0, 4) !== 'IEND')
    return 'no-IEND (truncated)';
  return 'ok';
}
function jpgStatus(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8)
    return 'bad-jpg-header';
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9)
    return 'no-EOI (truncated)';
  return 'ok';
}
function statusFor(file, buf) {
  if (file.endsWith('.webp')) return webpStatus(buf);
  if (file.endsWith('.png')) return pngStatus(buf);
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return jpgStatus(buf);
  return 'ok';
}

// 1. Validate
const bad = [];
let okCount = 0;
for (const p of refs) {
  if (p.startsWith('/fonts/') || p.startsWith('/seo/')) continue;
  const dest = path.join(PUB, p);
  if (!fs.existsSync(dest)) {
    bad.push({ p, dest, reason: 'MISSING' });
    continue;
  }
  const buf = fs.readFileSync(dest);
  const st = statusFor(path.basename(p), buf);
  if (st === 'ok') okCount++;
  else bad.push({ p, dest, reason: st });
}

console.log(
  `Validated ${refs.size} referenced images: ${okCount} ok, ${bad.length} bad`,
);
for (const b of bad) console.log(`  BAD [${b.reason}] ${b.p}`);

// 2. Repair (re-download bad ones via fetch, then re-validate)
let repaired = 0,
  failed = 0;
for (const b of bad) {
  const url = remoteFor(b.p);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.log(`  FAIL ${res.status} ${b.p}`);
      failed++;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const st = statusFor(path.basename(b.p), buf);
    if (st !== 'ok') {
      console.log(`  STILL-BAD [${st}] ${b.p}`);
      failed++;
      continue;
    }
    fs.mkdirSync(path.dirname(b.dest), { recursive: true });
    fs.writeFileSync(b.dest, buf);
    console.log(`  REPAIRED ${b.p} (${buf.length}b)`);
    repaired++;
  } catch (e) {
    console.log(`  ERROR ${b.p}: ${e}`);
    failed++;
  }
}
console.log(`\nRepaired ${repaired}, failed ${failed}.`);
