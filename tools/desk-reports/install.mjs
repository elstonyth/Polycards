// Copies the desk-reports MCP server to the Hermes ops folder and installs its
// two dependencies there, so the desk bots never run code from a git checkout
// whose branch can change under them. Usage: node tools/desk-reports/install.mjs
import { cpSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(process.env.LOCALAPPDATA, 'hermes', 'ops', 'desk-reports');
mkdirSync(target, { recursive: true });
for (const file of [
  'package.json',
  'server.mjs',
  'tools.mjs',
  'http.mjs',
  'periods.mjs',
]) {
  cpSync(join(here, file), join(target, file));
}
// npm is npm.cmd on Windows, which needs a shell to start.
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: target,
  stdio: 'inherit',
  shell: true,
});
console.log(`installed to ${target}`);
