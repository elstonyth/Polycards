// Read-only access to the Polycards source code for the desk bots
// (2026-10-06, the owner's "give it everything"): list, search and read the
// code on master, as GitHub has it. It reads a bare clone next to this
// server (POLYCARDS_SRC, default ../polycards-src, made by install.mjs),
// fetched at most every 10 minutes. A bare clone holds tracked files only,
// so a real .env never exists there; tracked env files (templates and
// examples, some with test logins), the deploy app specs and key files are
// refused anyway.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REF = 'master';
const REFRESH_MS = 10 * 60 * 1000;
const MAX_MATCHES = 150;
const MAX_LINES = 400;
const MAX_LINE_CHARS = 240;
// Hermes spills a tool result over 50K characters (counted once JSON
// escapes it) to a file the bot cannot read.
const MAX_ANSWER_CHARS = 38_000;
const GIT_TIMEOUT_MS = 30_000;

export const SRC =
  process.env.POLYCARDS_SRC ||
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'polycards-src');

export class CodeError extends Error {}

// A background server must never wait on a login prompt.
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};

// Git for Windows' git.exe on PATH is a launcher: a timeout kills it and
// leaves the real git running (holding the clone's locks). Run the real one.
let realGit;
const gitBinary = () =>
  (realGit ??= run('git', ['--exec-path'], { windowsHide: true })
    .then(({ stdout }) => {
      const bin = join(
        stdout.trim(),
        process.platform === 'win32' ? 'git.exe' : 'git',
      );
      return existsSync(bin) ? bin : 'git';
    })
    .catch(() => 'git'));

const git = async (src, args) =>
  run(await gitBinary(), ['--git-dir', src, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: ENV,
  });

const fetchedAt = new Map();
async function fresh(src) {
  if (Date.now() - (fetchedAt.get(src) ?? 0) < REFRESH_MS) return;
  fetchedAt.set(src, Date.now());
  try {
    await git(src, [
      // Give up on a stalled transfer rather than hold the clone's locks.
      '-c',
      'http.lowSpeedLimit=1000',
      '-c',
      'http.lowSpeedTime=20',
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

/** True for a path the bots may not open: env files anywhere in a name
 *  (.env, .env.example, staging.env.example, .envrc), the deploy app specs
 *  and key files. */
export const hiddenPath = (path) => {
  const segments = String(path).replace(/\\/g, '/').split('/');
  return (
    segments.some((s) => /\.env(rc)?(\.|$)/i.test(s) || /^\.do$/i.test(s)) ||
    /\.(pem|key|p12|pfx)$/i.test(segments.at(-1) ?? '')
  );
};

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

// What git says when a path or revision is simply not there.
const NOT_THERE =
  /does not exist|exists on disk, but not in|invalid object name|not a valid object name|unknown revision|bad revision/i;
// Anything else (no clone, no git) is this PC's problem, not a missing file.
const unavailable = () =>
  new CodeError(
    'The copy of the source code on this PC is not available. Tell the admin: run tools/desk-reports/install.mjs.',
  );

const clip = (line) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
// A line's cost once JSON escapes it, plus its newline.
const cost = (line) => JSON.stringify(line).length - 1;

/** The entries of one folder: subfolders end in /. */
export async function codeFiles({ path } = {}, src = SRC) {
  const dir = cleanPath(path, { required: false });
  await fresh(src);
  let stdout;
  try {
    ({ stdout } = await git(src, [
      'ls-tree',
      REF,
      ...(dir ? ['--', `${dir}/`] : []),
    ]));
  } catch {
    throw unavailable();
  }
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
  const shown = [];
  let size = 0;
  for (const name of entries) {
    size += cost(name);
    if (size > MAX_ANSWER_CHARS) break;
    shown.push(name);
  }
  const more =
    shown.length < entries.length
      ? `\n(${entries.length} entries; the first ${shown.length} shown.)`
      : '';
  return `${dir || '(top level)'} on master:\n${shown.join('\n')}${more}`;
}

// git grep's lines as they come, stopping it once `max` + 1 visible matches
// are in: a pattern like "." matches every line of the repo (tens of MB).
const grepLines = (bin, args, max) =>
  new Promise((done, fail) => {
    const child = spawn(bin, args, { windowsHide: true, env: ENV });
    const lines = [];
    let stderr = '';
    let enough = false;
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (enough) return;
      const shown = line.slice(REF.length + 1);
      if (hiddenPath(shown.split(':', 1)[0])) return;
      lines.push(clip(shown));
      if (lines.length > max) {
        enough = true;
        child.kill();
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      fail(unavailable());
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // git grep exits 1 when nothing matches.
      if (enough || code === 0 || (code === 1 && !stderr.trim())) {
        done(lines);
      } else if (/not a git repository/i.test(stderr)) {
        fail(unavailable());
      } else {
        fail(
          new CodeError(
            `The search failed: ${stderr.trim().split('\n')[0] || `git stopped (${code ?? 'timed out'})`}`,
          ),
        );
      }
    });
  });

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
  const lines = await grepLines(
    await gitBinary(),
    [
      '--git-dir',
      src,
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
    ],
    MAX_MATCHES,
  );
  if (!lines.length) {
    return `No matches for ${pattern}${dir ? ` in ${dir}` : ''}.`;
  }
  const shown = [];
  let size = 0;
  for (const line of lines.slice(0, MAX_MATCHES)) {
    size += cost(line);
    if (size > MAX_ANSWER_CHARS) break;
    shown.push(line);
  }
  const more =
    lines.length > shown.length
      ? `\n(More than ${shown.length} matches; the first ${shown.length} shown. Narrow it with path or a tighter pattern.)`
      : '';
  return `${shown.join('\n')}${more}`;
}

/** One file, numbered, at most 400 lines (and well under 50K characters)
 *  a call. */
export async function codeRead({ path, from, to } = {}, src = SRC) {
  const file = cleanPath(path, { required: true });
  await fresh(src);
  let stdout;
  try {
    ({ stdout } = await git(src, ['show', `${REF}:${file}`]));
  } catch (err) {
    if (NOT_THERE.test(String(err?.stderr ?? ''))) {
      throw new CodeError(
        `No file ${file} on master. Find it with code_files or code_search.`,
      );
    }
    throw unavailable();
  }
  if (stdout.includes('\0')) return `${file} is a binary file.`;
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0]?.startsWith(`tree ${REF}:`)) {
    throw new CodeError(`${file} is a folder: list it with code_files.`);
  }
  const start = Math.max(1, Math.trunc(Number(from)) || 1);
  if (start > lines.length) {
    throw new CodeError(`${file} has only ${lines.length} lines.`);
  }
  const last = Math.min(
    lines.length,
    Math.trunc(Number(to)) || lines.length,
    start + MAX_LINES - 1,
  );
  const shown = [];
  let size = 0;
  for (let n = start; n <= last; n += 1) {
    const line = `${n}| ${clip(lines[n - 1])}`;
    size += cost(line);
    if (size > MAX_ANSWER_CHARS && shown.length) break;
    shown.push(line);
  }
  const end = start + shown.length - 1;
  const rest =
    end < lines.length
      ? `\n(lines ${start}-${end} of ${lines.length}; read on with from=${end + 1})`
      : '';
  return `${file} (master, ${lines.length} lines)\n${shown.join('\n')}${rest}`;
}
