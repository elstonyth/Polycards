// Bulk-add custom pixel sprites (e.g. the One Piece set) to the admin
// pixel-Pokémon library. For each manifest entry: upload the file through
// POST /admin/media (kind=sprite — stored byte-for-byte, so an idle-loop GIF
// keeps animating), then create the library row with POST /admin/pixel-pokemon.
// Cards are then linked to these rows in the admin card form's picker.
//
// Idempotent: an entry whose name + variant already exists as a custom row is
// skipped, so a re-run after a failure only does what is left.
//
// Usage:
//   QA_JWT_FILE=/path/admin.jwt [BACKEND_URL=http://localhost:9000] \
//     node scripts/upload-pixel-sprites.mjs <dir> [--dry-run]
// (ADMIN_TOKEN=<jwt> works instead of QA_JWT_FILE.) <dir> holds the sprite
// files plus manifest.json: [{ "file", "name", "variant"?, "types"? }].
// Writes <dir>/upload-results.json: [{ file, name, status, id?, image_url?, error? }].
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:9000';
const dir = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!dir) {
  console.error(
    'usage: node scripts/upload-pixel-sprites.mjs <dir> [--dry-run]',
  );
  process.exit(2);
}
const token =
  process.env.ADMIN_TOKEN ||
  (process.env.QA_JWT_FILE &&
    readFileSync(process.env.QA_JWT_FILE, 'utf8').trim());
if (!token && !dryRun) {
  console.error('Set ADMIN_TOKEN or QA_JWT_FILE (an admin JWT).');
  process.exit(2);
}

const MIME = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const key = (name, variant) => `${name}\u0000${variant ?? 'custom'}`;

async function api(path, init = {}) {
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `${init.method ?? 'GET'} ${path} → ${res.status} ${body.message ?? ''}`.trim(),
    );
  return body;
}

// Existing custom rows, so re-runs skip what is already there.
const existing = new Map();
if (!dryRun) {
  for (let offset = 0; ; offset += 200) {
    const page = await api(
      `/admin/pixel-pokemon?custom=true&limit=200&offset=${offset}`,
    );
    for (const p of page.pixel_pokemon) existing.set(key(p.name, p.variant), p);
    if (offset + 200 >= page.total) break;
  }
}

const results = [];
for (const entry of manifest) {
  const { file, name, variant = 'custom', types = [] } = entry;
  const type = MIME[extname(file).toLowerCase()];
  if (!name || !type) {
    results.push({
      file,
      name,
      status: 'failed',
      error: 'needs a name and a .gif/.png/.webp file',
    });
    continue;
  }
  const found = existing.get(key(name, variant));
  if (found) {
    results.push({
      file,
      name,
      status: 'exists',
      id: found.id,
      image_url: found.image_url,
    });
    continue;
  }
  if (dryRun) {
    results.push({ file, name, status: 'would-upload' });
    continue;
  }
  try {
    const form = new FormData();
    form.append('kind', 'sprite');
    form.append(
      'files',
      new Blob([readFileSync(join(dir, file))], { type }),
      file,
    );
    const { url } = await api('/admin/media', { method: 'POST', body: form });
    const { pixel_pokemon: row } = await api('/admin/pixel-pokemon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, image_url: url, variant, types }),
    });
    results.push({
      file,
      name,
      status: 'created',
      id: row.id,
      image_url: row.image_url,
    });
  } catch (err) {
    results.push({
      file,
      name,
      status: 'failed',
      error: String(err.message ?? err),
    });
  }
  const last = results.at(-1);
  console.log(
    `${last.status.padEnd(8)} ${name}${last.error ? ` — ${last.error}` : ''}`,
  );
}

writeFileSync(
  join(dir, 'upload-results.json'),
  JSON.stringify(results, null, 1),
);
const count = (s) => results.filter((r) => r.status === s).length;
console.log(
  `created ${count('created')}, already there ${count('exists')}, would upload ${count('would-upload')}, failed ${count('failed')}`,
);
process.exit(count('failed') ? 1 : 0);
