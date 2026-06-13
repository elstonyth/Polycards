// Restore the backend's /static upload files after they were wiped (a backend
// rebuild cleared the upload dir while the DB kept absolute /static/... URLs —
// every referenced image 404'd).
//
// The Medusa local file provider names uploads "<epoch-ms>-<original-name>", so
// each missing file maps back to its source under the storefront's public/ by
// basename. This script queries the DB for every referenced /static URL, finds
// the source file, and copies it to backend/packages/api/static/ (the upload dir
// when the backend runs from packages/api). Idempotent — existing files skip.
//
// Run from the repo root: node scripts/restore-backend-static.mjs
// FORCE=1 overwrites files that already exist (use after editing the public/
// sources, e.g. the pedestal crop, so the backend serves the new bytes).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const STATIC_DIR = path.resolve('backend/packages/api/static');
const PUBLIC_DIR = path.resolve('public');
fs.mkdirSync(STATIC_DIR, { recursive: true });

const sql =
  "SELECT image FROM pack WHERE image LIKE '%/static/%' " +
  "UNION SELECT image FROM card WHERE image LIKE '%/static/%' " +
  "UNION SELECT url FROM image WHERE url LIKE '%/static/%' " +
  "UNION SELECT thumbnail FROM product WHERE thumbnail LIKE '%/static/%';";
const out = execFileSync(
  'docker',
  [
    'exec',
    'pokenic-postgres',
    'psql',
    '-U',
    'medusa',
    '-d',
    'medusa',
    '-t',
    '-A',
    '-c',
    sql,
  ],
  { encoding: 'utf8' },
);
const urls = [
  ...new Set(
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  ),
];

// index public/ once: basename -> full path
const index = new Map();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (!index.has(e.name)) index.set(e.name, p);
  }
})(PUBLIC_DIR);

let restored = 0,
  present = 0;
const missing = [];
for (const url of urls) {
  const file = url.split('/static/')[1];
  if (!file) continue;
  const dest = path.join(STATIC_DIR, file);
  if (fs.existsSync(dest) && process.env.FORCE !== '1') {
    present++;
    continue;
  }
  const base = file.replace(/^\d{13}-/, '');
  const src = index.get(base);
  if (!src) {
    missing.push(file);
    continue;
  }
  fs.copyFileSync(src, dest);
  restored++;
}
console.log(
  `referenced: ${urls.length}  restored: ${restored}  already-present: ${present}  unresolved: ${missing.length}`,
);
if (missing.length)
  console.log(
    'unresolved (no source under public/):\n  ' + missing.join('\n  '),
  );
