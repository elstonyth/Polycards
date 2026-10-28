// Bulk-add custom pixel sprites (e.g. the One Piece set) to the admin
// pixel-Pokémon library. For each manifest entry: upload the file through
// POST /admin/media (kind=sprite — stored byte-for-byte, so an idle-loop GIF
// keeps animating), then create the library row with POST /admin/pixel-pokemon.
// Cards are then linked to these rows in the admin card form's picker.
//
// Idempotent: an entry that already exists as a custom row (or appeared earlier
// in this run) is skipped, so a re-run after a failure only does what is left.
// A numbered entry (a One Piece "number") is matched by deck + number + variant,
// so renaming it in the manifest can't create a second row; an unnumbered one
// by deck + name + variant. A run is one operator at a time — nothing stops two
// overlapping runs from both creating a row. If the upload succeeded but the
// row did not, the results file keeps the uploaded URL (with the file's hash)
// and the next run reuses it while the file is unchanged, instead of storing a
// second copy (there is no media DELETE to clean up).
//
// Usage:
//   QA_JWT_FILE=/path/admin.jwt [BACKEND_URL=http://localhost:9000] \
//     node scripts/upload-pixel-sprites.mjs <dir> [--dry-run]
// (ADMIN_TOKEN=<jwt> works instead of QA_JWT_FILE; --dry-run without a token
// cannot see existing rows.) <dir> holds the sprite files plus manifest.json:
// [{ "file", "name", "franchise"?, "dex"?, "number"?, "variant"?, "types"? }] — franchise
// 'pokemon' (default, numbered by "dex") or 'one-piece' (numbered by "number").
// A real run writes <dir>/upload-results.json after every entry (a dry run
// writes nothing): [{ file, name, franchise, variant, number, status, id?,
// image_url?, sha256?, error? }].
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:9000';
const TIMEOUT_MS = 30_000; // a stalled request fails its entry, not the run
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
const resultsPath = join(dir, 'upload-results.json');
// The deck is part of the identity: a Pokémon and a One Piece row may share a
// name + variant. A numbered row is its number, whatever it is called.
const key = ({ franchise, name, number, variant }) =>
  [
    franchise ?? 'pokemon',
    number != null ? `#${number}` : name,
    variant ?? 'custom',
  ].join('\u0000');
const sha256 = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

async function api(path, init = {}) {
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `${init.method ?? 'GET'} ${path} → ${res.status} ${body.message ?? ''}`.trim(),
    );
  return body;
}

// Existing custom rows, so re-runs (and dry runs) skip what is already there.
const existing = new Map();
if (token) {
  for (let offset = 0; ; offset += 200) {
    const page = await api(
      `/admin/pixel-pokemon?custom=true&limit=200&offset=${offset}`,
    );
    for (const p of page.pixel_pokemon) existing.set(key(p), p);
    if (offset + 200 >= page.total) break;
  }
}

// Uploads a previous run stored but never got a row for — reused, not re-sent,
// while the file's bytes are unchanged. Only from the SAME backend: a local
// test run's localhost URL must never end up on a prod row when the same
// folder is uploaded to prod next. Ones this run doesn't reach are written
// back, so an interrupted run can't drop them.
const staged = new Map();
if (existsSync(resultsPath)) {
  for (const r of JSON.parse(readFileSync(resultsPath, 'utf8'))) {
    if (
      r.status === 'failed' &&
      r.image_url &&
      r.sha256 &&
      r.backend === BACKEND
    )
      staged.set(key(r), r);
  }
}

const results = [];
const save = () => {
  if (dryRun) return;
  const done = new Set(results.map(key));
  const carried = [...staged.values()].filter((r) => !done.has(key(r)));
  writeFileSync(resultsPath, JSON.stringify([...results, ...carried], null, 1));
};
for (const entry of manifest) {
  const {
    file,
    name,
    franchise = 'pokemon',
    dex = null,
    number = null,
    variant = 'custom',
    types = [],
  } = entry;
  const k = key({ franchise, name, number, variant });
  const who = { file, name, franchise, variant, number, backend: BACKEND };
  const type = MIME[extname(file).toLowerCase()];
  let result;
  if (!name || !type) {
    result = {
      ...who,
      status: 'failed',
      error: 'needs a name and a .gif/.png/.webp file',
    };
  } else if (existing.has(k)) {
    const found = existing.get(k);
    result = {
      ...who,
      status: 'exists',
      id: found.id,
      image_url: found.image_url,
    };
  } else if (dryRun) {
    result = { ...who, status: 'would-upload' };
    existing.set(k, { id: null, image_url: null }); // a repeat would not upload twice
  } else {
    let hash;
    let url;
    try {
      // Inside the try: a missing file fails its entry, not the run.
      hash = sha256(join(dir, file));
      const prior = staged.get(k);
      url = prior?.sha256 === hash ? prior.image_url : undefined;
      if (!url) {
        const form = new FormData();
        form.append('kind', 'sprite');
        form.append(
          'files',
          new Blob([readFileSync(join(dir, file))], { type }),
          file,
        );
        ({ url } = await api('/admin/media', { method: 'POST', body: form }));
      }
      const { pixel_pokemon: row } = await api('/admin/pixel-pokemon', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          franchise,
          dex,
          number,
          image_url: url,
          variant,
          types,
        }),
      });
      existing.set(k, row);
      result = {
        ...who,
        status: 'created',
        id: row.id,
        image_url: row.image_url,
      };
    } catch (err) {
      // image_url (when the upload got through) lets the next run reuse it.
      result = {
        ...who,
        status: 'failed',
        image_url: url,
        sha256: hash,
        error: String(err.message ?? err),
      };
    }
  }
  results.push(result);
  save();
  console.log(
    `${result.status.padEnd(8)} ${name}${result.error ? ` — ${result.error}` : ''}`,
  );
}

const count = (s) => results.filter((r) => r.status === s).length;
console.log(
  `created ${count('created')}, already there ${count('exists')}, would upload ${count('would-upload')}, failed ${count('failed')}`,
);
// exitCode, not process.exit(): exiting while fetch's keep-alive sockets are
// still closing trips a libuv assertion on Windows (UV_HANDLE_CLOSING, 0xC0000409).
process.exitCode = count('failed') ? 1 : 0;
