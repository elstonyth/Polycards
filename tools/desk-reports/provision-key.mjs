// Generates one desk's report key and writes it, never printed, to the two
// places that must agree: deploy/.env.deploy in the MAIN checkout (read by
// scripts/do-apply.ps1) and the desk's Hermes profile .env (read into the MCP
// server's env). Re-running rotates the key; apply and restart Hermes after.
// Both files are read and checked before either is written, and each is
// replaced by renaming a temp file over it, so a failed run never leaves a
// half-written secrets file. No .bak copy is made: it would be one more
// plaintext copy of every production secret.
// Usage: node tools/desk-reports/provision-key.mjs <finance|store|support|growth|developer> <main checkout path>
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const [desk, repo] = process.argv.slice(2);
if (
  !['finance', 'store', 'support', 'growth', 'developer'].includes(desk) ||
  !repo
) {
  throw new Error(
    'usage: provision-key.mjs <finance|store|support|growth|developer> <main checkout path>',
  );
}
if (!process.env.LOCALAPPDATA) {
  throw new Error(
    "LOCALAPPDATA is not set, so the desk's Hermes profile cannot be found. Run this on the PC that hosts the desk bots.",
  );
}
const name = `REPORT_KEY_${desk.toUpperCase()}`;
const files = [
  join(repo, 'deploy', '.env.deploy'),
  join(
    process.env.LOCALAPPDATA,
    'hermes',
    'profiles',
    `polycards-${desk}`,
    '.env',
  ),
];
for (const file of files)
  if (!existsSync(file)) throw new Error(`missing ${file}`);

// Read and check BOTH files before writing either. A UTF-16 file (NULs) or any
// other non-UTF-8 text would be re-encoded as garbage, so it is refused as is.
const texts = files.map((file) => {
  const text = readFileSync(file, 'utf8');
  if (text.includes('\0') || text.includes('\u{FFFD}')) {
    throw new Error(
      `${file} is not UTF-8 text (it holds NUL or undecodable bytes), so nothing was written. Convert it to UTF-8, then run this again.`,
    );
  }
  return text;
});
const value = randomBytes(32).toString('hex');
const updated = texts.map((text) => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(`${name}=`));
  while (lines.length && lines.at(-1) === '') lines.pop();
  return [...lines, `${name}=${value}`, ''].join(eol);
});

// Stage both new files next to their targets, then swap them in. A failure
// while staging changes nothing; only one between the two swaps can leave the
// files with different keys, and running this again rotates both.
const staged = files.map((file) => `${file}.tmp-${process.pid}`);
let writing = files[0];
try {
  for (const [i, file] of files.entries()) {
    writing = file;
    writeFileSync(staged[i], updated[i]);
  }
  for (const [i, file] of files.entries()) {
    writing = file;
    renameSync(staged[i], file);
  }
} catch (error) {
  for (const tmp of staged) rmSync(tmp, { force: true });
  throw new Error(
    `Could not write ${writing} (${error.code ?? 'error'}). Run this script again: it rotates both files, and until then they may hold different keys.`,
    { cause: error },
  );
}
console.log(`${name} written to ${files.length} files (value not shown).`);
