// Download the per-pack claw-machine render ({slug}-1.avif) for every pack the
// clone has, derived from the existing {slug}-icon.webp filenames. Saves as
// {slug}-machine.avif (+ .webp fallback) in public/images/claw/.
import { readdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DIR = 'public/images/claw';
const REMOTE = 'https://www.phygitals.com/images/claw';

const files = await readdir(DIR);
const bases = files
  .filter((f) => f.endsWith('-icon.webp'))
  .map((f) => f.replace('-icon.webp', ''));
console.log(`${bases.length} pack slugs derived from icons`);

async function tryDownload(url, dest) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, status: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return { ok: false, status: 'too-small' };
    await writeFile(dest, buf);
    return { ok: true, bytes: buf.length };
  } catch (e) {
    return { ok: false, status: e.message };
  }
}

const report = [];
for (const base of bases) {
  // claw machine = {base}-1 ; prefer avif, fallback webp
  const avif = await tryDownload(
    `${REMOTE}/${base}-1.avif`,
    `${DIR}/${base}-machine.avif`,
  );
  const webp = await tryDownload(
    `${REMOTE}/${base}-1.webp`,
    `${DIR}/${base}-machine.webp`,
  );
  const got = [];
  if (avif.ok) got.push(`avif ${avif.bytes}`);
  if (webp.ok) got.push(`webp ${webp.bytes}`);
  report.push(
    `${base.padEnd(34)} ${got.length ? got.join(' + ') : 'FAILED (' + (avif.status || '') + '/' + (webp.status || '') + ')'}`,
  );
}
console.log(report.join('\n'));
console.log('\ndone');
