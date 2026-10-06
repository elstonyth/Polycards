// Read-only access to the Polycards source code for the desk bots
// (2026-10-06, the owner's "give it everything"): list, search and read the
// code on master, as GitHub has it. It reads a bare clone next to this
// server (POLYCARDS_SRC, default ../polycards-src, made by install.mjs),
// fetched at most every 10 minutes. A bare clone holds tracked files only,
// so a real .env never exists there; the env templates and the app specs
// (.do/, which carry encrypted secrets) are refused anyway.
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REF = 'master';
const REFRESH_MS = 10 * 60 * 1000;
const MAX_MATCHES = 150;
const MAX_LINES = 400;
const MAX_LINE_CHARS = 240;

export const SRC =
  process.env.POLYCARDS_SRC ||
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'polycards-src');

export class CodeError extends Error {}

const git = (src, args) =>
  run('git', ['--git-dir', src, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
    // A background server must never wait on a login prompt.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });

const fetchedAt = new Map();
async function fresh(src) {
  if (Date.now() - (fetchedAt.get(src) ?? 0) < REFRESH_MS) return;
  fetchedAt.set(src, Date.now());
  try {
    await git(src, [
      'fetch',
      '--quiet',
      '--depth',
      '1',
      'origin',
      `+refs/heads/${REF}:refs/heads/${REF}`,
    ]);
  } catch {
    // Offline or refused: answer from the copy already here.
  }
}

/** True for a path the bots may not open. */
export const hiddenPath = (path) =>
  /(^|\/)\.env/i.test(path) ||
  /(^|\/)\.do(\/|$)/i.test(path) ||
  /\.(pem|key|p12|pfx)$/i.test(path);

/** A repo path as git wants it, or a CodeError saying why not. */
function cleanPath(path, { required }) {
  const p = String(path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/\/+$/, '');
  if (!p) {
    if (required) throw new CodeError('path is required, like CONTEXT.md.');
    return '';
  }
  if (p.split('/').some((s) => s === '..' || s === '.')) {
    throw new CodeError('path must be a plain repo path, without . or ..');
  }
  if (hiddenPath(p)) {
    throw new CodeError(
      'That file is not open to the desk bots: it holds secrets.',
    );
  }
  return p;
}

const clip = (line) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;

/** The entries of one folder: subfolders end in /. */
export async function codeFiles({ path } = {}, src = SRC) {
  const dir = cleanPath(path, { required: false });
  await fresh(src);
  const { stdout } = await git(src, [
    'ls-tree',
    REF,
    ...(dir ? ['--', `${dir}/`] : []),
  ]);
  const entries = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, name] = line.split('\t');
      return meta.split(' ')[1] === 'tree' ? `${name}/` : name;
    })
    .filter((name) => !hiddenPath(name));
  if (!entries.length) {
    throw new CodeError(
      `No folder ${dir} on master. List the top level with no path.`,
    );
  }
  return `${dir || '(top level)'} on master:\n${entries.join('\n')}`;
}

/** Lines matching a regular expression (PCRE), as path:line: text. */
export async function codeSearch(
  { pattern, path, ignore_case } = {},
  src = SRC,
) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw new CodeError(
      'pattern is required, like definePolicies or ledger_entry.',
    );
  }
  const dir = cleanPath(path, { required: false });
  await fresh(src);
  let stdout;
  try {
    ({ stdout } = await git(src, [
      'grep',
      '-n',
      '-I',
      '-P',
      ...(ignore_case ? ['-i'] : []),
      '-e',
      pattern,
      REF,
      '--',
      ...(dir ? [dir] : []),
    ]));
  } catch (err) {
    // git grep exits 1 when nothing matches.
    if (err.code === 1)
      return `No matches for ${pattern}${dir ? ` in ${dir}` : ''}.`;
    throw new CodeError(
      `The search failed: ${
        String(err.stderr || err.message)
          .trim()
          .split('\n')[0]
      }`,
    );
  }
  const matches = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(REF.length + 1))
    .filter((line) => !hiddenPath(line.split(':', 1)[0]));
  const shown = matches.slice(0, MAX_MATCHES).map(clip);
  const more =
    matches.length > MAX_MATCHES
      ? `\n(${matches.length} matches; the first ${MAX_MATCHES} shown. Narrow it with path or a tighter pattern.)`
      : '';
  return matches.length
    ? `${shown.join('\n')}${more}`
    : `No matches for ${pattern}${dir ? ` in ${dir}` : ''}.`;
}

/** One file, numbered, at most 400 lines a call. */
export async function codeRead({ path, from, to } = {}, src = SRC) {
  const file = cleanPath(path, { required: true });
  await fresh(src);
  let stdout;
  try {
    ({ stdout } = await git(src, ['show', `${REF}:${file}`]));
  } catch {
    throw new CodeError(
      `No file ${file} on master. Find it with code_files or code_search.`,
    );
  }
  if (stdout.includes('\0')) return `${file} is a binary file.`;
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0]?.startsWith(`tree ${REF}:`)) {
    throw new CodeError(`${file} is a folder: list it with code_files.`);
  }
  const start = Math.max(1, Math.trunc(Number(from)) || 1);
  const end = Math.min(
    lines.length,
    Math.trunc(Number(to)) || lines.length,
    start + MAX_LINES - 1,
  );
  if (start > lines.length) {
    throw new CodeError(`${file} has only ${lines.length} lines.`);
  }
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${start + i}| ${clip(line)}`)
    .join('\n');
  const rest =
    end < lines.length
      ? `\n(lines ${start}-${end} of ${lines.length}; read on with from=${end + 1})`
      : '';
  return `${file} (master, ${lines.length} lines)\n${body}${rest}`;
}
