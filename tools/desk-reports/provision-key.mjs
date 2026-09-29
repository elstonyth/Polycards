// Generates one desk's report key and writes it, never printed, to the two
// places that must agree: deploy/.env.deploy in the MAIN checkout (read by
// scripts/do-apply.ps1) and the desk's Hermes profile .env (read into the MCP
// server's env). Re-running rotates the key; apply and restart Hermes after.
// Usage: node tools/desk-reports/provision-key.mjs <finance|store|support|growth> <main checkout path>
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [desk, repo] = process.argv.slice(2);
if (!['finance', 'store', 'support', 'growth'].includes(desk) || !repo) {
  throw new Error(
    'usage: provision-key.mjs <finance|store|support|growth> <main checkout path>',
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
const value = randomBytes(32).toString('hex');
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(`${name}=`));
  while (lines.length && lines.at(-1) === '') lines.pop();
  writeFileSync(file, [...lines, `${name}=${value}`, ''].join(eol));
}
console.log(`${name} written to ${files.length} files (value not shown).`);
