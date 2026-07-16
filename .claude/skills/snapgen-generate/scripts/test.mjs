// Self-check for snapgen.mjs — runs WITHOUT a real API key.
// Spins a mock SnapGen server, then exercises: missing-key error, dry-run
// request shape, submit→poll→completed flow, and result-URL extraction.
//   node test.mjs
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'snapgen.mjs');
// Hermetic cwd: the CLI auto-loads SNAPGEN_API_KEY from a .env in its cwd, so
// running tests from the repo root would pick up the REAL key and submit a
// REAL paid job (happened 2026-07-16 — test 1 spent credits on "a cat").
// Every child runs from an empty temp dir unless a test overrides cwd.
const hermeticDir = await mkdtemp(join(tmpdir(), 'snapgen-hermetic-'));
// MUST be async: the mock server lives in THIS process — a sync child call
// (execFileSync) blocks the event loop, the server never answers, the child
// hangs until undici's headers timeout. Learned the hard way.
const run = (args, env = {}) =>
  new Promise((resolve) => {
    execFile(
      'node',
      [CLI, ...args],
      {
        cwd: hermeticDir,
        env: { ...process.env, SNAPGEN_API_KEY: '', ...env },
        encoding: 'utf8',
        timeout: 20_000,
      },
      (err, stdout, stderr) =>
        resolve({ out: stdout + stderr, code: err ? (err.code ?? 1) : 0 }),
    );
  });

// --- 1. missing key fails clean, never sends ---
{
  const r = await run(['image', 'a cat']);
  assert.notStrictEqual(r.code, 0, 'missing key must exit non-zero');
  assert.match(r.out, /SNAPGEN_API_KEY/, 'must name the env var');
}

// --- 2. dry-run prints request shape, sends nothing, no key needed ---
{
  const r = await run([
    'image',
    'gold VIP logo',
    '--model',
    'nano-banana-2',
    '--aspect_ratio',
    '3:2',
    '--dry-run',
  ]);
  assert.strictEqual(r.code, 0, 'dry-run must succeed without key: ' + r.out);
  assert.match(r.out, /uapi\/v1\/generate_image/);
  assert.match(r.out, /nano-banana-2/);
  assert.match(r.out, /3:2/);
}
{
  const r = await run([
    'gpt-image',
    'test',
    '--mode',
    'medium',
    '--resolution',
    '2K',
    '--dry-run',
  ]);
  assert.match(r.out, /imagen\/gpt-image-2/);
  assert.match(r.out, /medium/);
}
{
  const r = await run([
    'video',
    'kling',
    'test',
    '--model',
    'kling-video-3-0',
    '--dry-run',
  ]);
  assert.match(r.out, /video-gen\/kling/);
}
{
  const r = await run([
    'meta-image',
    'test',
    '--orientation',
    'portrait',
    '--dry-run',
  ]);
  assert.match(r.out, /meta_ai\/generate/);
  assert.match(r.out, /portrait/);
}
{
  // ref_history is a plain passthrough field — no upload, just the uuid string
  const r = await run([
    'grok-image',
    'test',
    '--mode',
    'QUALITY',
    '--ref_history',
    'abc-123',
    '--dry-run',
  ]);
  assert.match(r.out, /imagen\/grok/);
  assert.match(r.out, /QUALITY/);
  assert.match(r.out, /abc-123/);
}
{
  const r = await run([
    'extend',
    'seedance',
    'keep the camera pushing in',
    '--ref_history',
    'uuid-1',
    '--dry-run',
  ]);
  assert.match(r.out, /video-extend\/seedance/);
  assert.match(r.out, /uuid-1/);
}
{
  const r = await run(['extend', 'sora', 'x', '--dry-run']);
  assert.notStrictEqual(r.code, 0, 'extend sora must be rejected');
}
{
  // scenes is a JSON-array string (2-10 scenes) — passed through verbatim
  const scenes =
    '[{"prompt":"sunrise","duration":6,"mode":"custom"},{"prompt":"city","duration":6,"mode":"custom"}]';
  const r = await run(['storyboard', scenes, '--dry-run']);
  assert.match(r.out, /video-storyboard\/grok/);
  assert.ok(r.out.includes('sunrise'), 'scenes JSON must pass through');
}

// --- 2a2. dry-run preserves repeated multipart fields as arrays (exact preview) ---
{
  const dir = await mkdtemp(join(tmpdir(), 'snapgen-dryfiles-'));
  await writeFile(join(dir, 'a.png'), 'A');
  await writeFile(join(dir, 'b.png'), 'B');
  const r = await run([
    'image',
    'two refs',
    '--files',
    `${join(dir, 'a.png')},${join(dir, 'b.png')}`,
    '--dry-run',
  ]);
  await rm(dir, { recursive: true, force: true });
  assert.strictEqual(r.code, 0, 'dry-run with files failed: ' + r.out);
  const files = (r.out.match(/<file>/g) ?? []).length;
  assert.strictEqual(files, 2, 'dry-run must show BOTH files, got ' + files);
}

// --- 2b. enum typo guard: warns (non-fatal) on unknown values, silent on valid ---
{
  const bad = await run(['image', 'x', '--aspect_ratio', '7:5', '--dry-run']);
  assert.strictEqual(bad.code, 0, 'enum warning must not block dry-run');
  assert.match(bad.out, /warn: aspect_ratio="7:5"/, 'bad enum must warn');
  const good = await run(['image', 'x', '--aspect_ratio', '9:16', '--dry-run']);
  assert.ok(!good.out.includes('warn:'), 'valid enum must not warn');
  const vid = await run([
    'video',
    'grok',
    'x',
    '--resolution',
    '1080p',
    '--dry-run',
  ]);
  assert.match(vid.out, /warn: resolution="1080p"/, 'grok 1080p must warn');
  const kling = await run([
    'video',
    'kling',
    'x',
    '--mode',
    'relax',
    '--dry-run',
  ]);
  assert.ok(!kling.out.includes('warn:'), 'kling relax mode must not warn');
  // extend has its own param sets (mode default "fast") — guard must not apply
  const ext = await run([
    'extend',
    'kling',
    'x',
    '--ref_history',
    'u1',
    '--mode',
    'fast',
    '--dry-run',
  ]);
  assert.ok(
    !ext.out.includes('warn:'),
    'extend kling --mode fast must not warn',
  );
}

// --- 3. live flow against mock: submit → poll(processing→completed) → URL ---
const seen = [];
let polls = 0;
const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => handle(req, res, body));
});
const handle = (req, res, body) => {
  seen.push({
    method: req.method,
    url: req.url,
    key: req.headers['x-api-key'],
    body,
  });
  res.setHeader('content-type', 'application/json');
  if (req.method === 'POST' && req.url === '/uapi/v1/generate_image') {
    // Prompt markers route to dedicated uuids so tests don't share state.
    const uuid = body.includes('FAILTEST')
      ? 'fail0001'
      : body.includes('DLTEST')
        ? 'dl000001'
        : body.includes('ALPHATEST')
          ? 'alpha001'
          : 'mock-uuid-1';
    res.end(
      JSON.stringify({
        uuid,
        status: 1,
        status_desc: 'queued',
        estimated_credit: 3,
      }),
    );
  } else if (req.url === '/uapi/v1/history/fail0001') {
    res.end(
      JSON.stringify({
        uuid: 'fail0001',
        status: 3,
        error_code: 'IP_DETECTED',
        error_message: 'content policy',
      }),
    );
  } else if (req.url === '/uapi/v1/history/dl000001') {
    // history schema names this field image_uri (not image_url) on nested items
    res.end(
      JSON.stringify({
        uuid: 'dl000001',
        status: 2,
        used_credit: 3,
        generated_image: [
          { image_uri: base + '/mock-img.png', file_download_url: null },
        ],
      }),
    );
  } else if (req.url === '/mock-img.png') {
    res.setHeader('content-type', 'image/png');
    res.end(Buffer.from('PNGBYTES'));
  } else if (req.url === '/uapi/v1/history/alpha001') {
    res.end(
      JSON.stringify({
        uuid: 'alpha001',
        status: 2,
        used_credit: 3,
        generated_image: [{ file_download_url: base + '/mock-alpha.png' }],
      }),
    );
  } else if (req.url === '/mock-alpha.png') {
    res.setHeader('content-type', 'image/png');
    res.end(alphaPng);
  } else if (req.url === '/uapi/v1/history/mock-uuid-1') {
    polls++;
    res.end(
      polls < 2
        ? JSON.stringify({
            uuid: 'mock-uuid-1',
            status: 1,
            status_percentage: 40,
          })
        : JSON.stringify({
            uuid: 'mock-uuid-1',
            status: 2,
            used_credit: 3,
            generated_image: [
              {
                image_url: 'https://cdn.mock/img1.png',
                file_download_url: null,
              },
            ],
            generated_video: [],
          }),
    );
  } else if (req.url === '/uapi/v1/account') {
    res.end(
      JSON.stringify({
        email: 'mock@x',
        plan_id: 'FP1',
        user_credit: { available_credit: 1234, locked_credit: 0 },
      }),
    );
  } else {
    res.statusCode = 404;
    res.end('{"detail":{"error_code":"RECORD_NOT_FOUND"}}');
  }
};
await new Promise((ok) => srv.listen(0, ok));
const base = `http://127.0.0.1:${srv.address().port}`;

// sharp for the --transparent keying test, resolved the same way the CLI does.
// 4x4 fixture: left half flat magenta (keys out), right half red (stays).
let sharpT = null;
let sharpDir = '';
try {
  const req = createRequire(join(here, 'x.js'));
  sharpDir = dirname(req.resolve('sharp/package.json'));
  sharpT = req('sharp');
} catch {}
let alphaPng = null;
if (sharpT) {
  const raw = Buffer.alloc(4 * 4 * 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      if (x < 2) {
        raw[i] = 255;
        raw[i + 1] = 0;
        raw[i + 2] = 255;
      } else {
        raw[i] = 200;
        raw[i + 1] = 30;
        raw[i + 2] = 40;
      }
      raw[i + 3] = 255;
    }
  alphaPng = await sharpT(raw, { raw: { width: 4, height: 4, channels: 4 } })
    .png()
    .toBuffer();
}
const env = {
  SNAPGEN_API_KEY: 'test-key-123',
  SNAPGEN_BASE: base,
  SNAPGEN_POLL_MS: '50',
};

{
  const r = await run(
    ['image', 'gold VIP logo', '--model', 'nano-banana-2', '--no-download'],
    env,
  );
  assert.strictEqual(r.code, 0, 'image gen flow failed: ' + r.out);
  assert.match(
    r.out,
    /https:\/\/cdn\.mock\/img1\.png/,
    'must print result URL',
  );
  assert.match(r.out, /used_credit.*3|3 credit/i, 'must report credits');
  assert.ok(
    seen.every((s) => s.key === 'test-key-123'),
    'key must be sent as x-api-key',
  );
  assert.ok(polls >= 2, 'must poll until completed');
}
{
  const r = await run(['account'], env);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /1234/, 'must show available credits');
}
// key must never be printed
{
  const all =
    (
      await run(
        ['image', 'x', '--model', 'nano-banana-2', '--no-download'],
        env,
      )
    ).out + (await run(['account'], env)).out;
  assert.ok(
    !all.includes('test-key-123'),
    'API key must never appear in output',
  );
}

// --- 4. dotenv auto-load: key comes from ./​.env in cwd, not process env ---
{
  const dir = await mkdtemp(join(tmpdir(), 'snapgen-test-'));
  await writeFile(join(dir, '.env'), 'SNAPGEN_API_KEY=envfile-key-456\n');
  const r = await new Promise((resolve) => {
    execFile(
      'node',
      [CLI, 'account'],
      {
        cwd: dir, // key comes ONLY from the .env here
        // the key var must be ABSENT (not empty): a set-but-empty var now
        // deliberately disables the dotenv fallback
        env: (() => {
          const e = { ...process.env, SNAPGEN_BASE: base };
          delete e.SNAPGEN_API_KEY;
          return e;
        })(),
        encoding: 'utf8',
        timeout: 20_000,
      },
      (err, stdout, stderr) =>
        resolve({ out: stdout + stderr, code: err ? (err.code ?? 1) : 0 }),
    );
  });
  await rm(dir, { recursive: true, force: true });
  assert.strictEqual(r.code, 0, 'env-file auto-load failed: ' + r.out);
  const last = seen.at(-1);
  assert.strictEqual(
    last.key,
    'envfile-key-456',
    'key must be read from cwd .env',
  );
  assert.ok(
    !r.out.includes('envfile-key-456'),
    'env-file key must never be printed',
  );
}

// --- 4b. set-but-EMPTY key must disable the dotenv fallback and die (never
// silently bill via a stray .env — the 2026-07-16 real-spend bug) ---
{
  const dir = await mkdtemp(join(tmpdir(), 'snapgen-emptykey-'));
  await writeFile(join(dir, '.env'), 'SNAPGEN_API_KEY=stray-key-789\n');
  const r = await new Promise((resolve) => {
    execFile(
      'node',
      [CLI, 'account'],
      {
        cwd: dir, // a .env with a key exists here…
        env: { ...process.env, SNAPGEN_API_KEY: '', SNAPGEN_BASE: base }, // …but env is explicitly empty
        encoding: 'utf8',
        timeout: 20_000,
      },
      (err, stdout, stderr) =>
        resolve({ out: stdout + stderr, code: err ? (err.code ?? 1) : 0 }),
    );
  });
  await rm(dir, { recursive: true, force: true });
  assert.notStrictEqual(r.code, 0, 'empty env key must die, not read .env');
  assert.ok(
    !seen.some((s) => s.key === 'stray-key-789'),
    'stray .env key must never reach the API',
  );
}

// --- 4c. valued flags must not eat the next flag as their value ---
{
  const r = await run(['image', 'x', '--model', '--dry-run']);
  assert.notStrictEqual(r.code, 0, 'missing option value must die');
  assert.match(r.out, /--model needs a value/, 'must name the flag');
}

// --- 5. --files comma-split → TWO multipart blobs; --file_urls → two url fields ---
{
  const dir = await mkdtemp(join(tmpdir(), 'snapgen-refs-'));
  await writeFile(join(dir, 'a.png'), 'A');
  await writeFile(join(dir, 'b.png'), 'B');
  const r = await run(
    [
      'image',
      'ref test',
      '--files',
      `${join(dir, 'a.png')},${join(dir, 'b.png')}`,
      '--no-wait',
    ],
    env,
  );
  await rm(dir, { recursive: true, force: true });
  assert.strictEqual(r.code, 0, '--files submit failed: ' + r.out);
  const body = seen.at(-1).body;
  const fileParts = (body.match(/name="files"; filename=/g) ?? []).length;
  assert.strictEqual(
    fileParts,
    2,
    'comma-split --files must upload 2 blobs, got ' + fileParts,
  );
}
{
  const r = await run(
    [
      'image',
      'url ref test',
      '--file_urls',
      'https://x/u1.png,https://x/u2.png',
      '--no-wait',
    ],
    env,
  );
  assert.strictEqual(r.code, 0, '--file_urls submit failed: ' + r.out);
  const body = seen.at(-1).body;
  assert.match(body, /u1\.png/);
  assert.match(body, /u2\.png/);
  const urlParts = (body.match(/name="file_urls"/g) ?? []).length;
  assert.strictEqual(urlParts, 2, '--file_urls must send 2 separate fields');
}

// --- 5b. media keys: local path → blob; URL and bare UUID → plain string ---
{
  const dir = await mkdtemp(join(tmpdir(), 'snapgen-mixed-'));
  await writeFile(join(dir, 'a.png'), 'A');
  const r = await run(
    [
      'image',
      'mixed ref test',
      '--ref_images',
      `${join(dir, 'a.png')},https://cdn.x/ref.png,550e8400-e29b-41d4-a716-446655440000`,
      '--no-wait',
    ],
    env,
  );
  await rm(dir, { recursive: true, force: true });
  assert.strictEqual(r.code, 0, 'mixed refs submit failed: ' + r.out);
  const body = seen.at(-1).body;
  const blobs = (body.match(/name="ref_images"; filename=/g) ?? []).length;
  assert.strictEqual(blobs, 1, 'only the local path must upload as a blob');
  assert.match(body, /https:\/\/cdn\.x\/ref\.png/, 'URL must pass as string');
  assert.match(
    body,
    /550e8400-e29b-41d4-a716-446655440000/,
    'uuid must pass as string',
  );
}

// --- 6. failed job (status 3) → non-zero exit, error_code surfaced ---
{
  const r = await run(['image', 'FAILTEST', '--no-download'], env);
  assert.notStrictEqual(r.code, 0, 'failed job must exit non-zero');
  assert.match(r.out, /IP_DETECTED/, 'must surface error_code');
}

// --- 7. --out <dir>: download lands in the target directory ---
{
  const dir = await mkdtemp(join(tmpdir(), 'snapgen-out-'));
  const r = await run(['image', 'DLTEST', '--out', dir], env);
  assert.strictEqual(r.code, 0, '--out flow failed: ' + r.out);
  const bytes = await readFile(join(dir, 'snapgen-dl000001-0.png'));
  assert.strictEqual(
    bytes.toString(),
    'PNGBYTES',
    'downloaded bytes must match',
  );
  await rm(dir, { recursive: true, force: true });
}

// --- 8. --transparent: magenta clause injected, keyed to real alpha, trimmed ---
{
  const r0 = await run(['image', 'a gold logo', '--transparent', '--dry-run']);
  assert.match(r0.out, /FF00FF/i, 'transparent must inject the magenta clause');
  assert.match(
    r0.out,
    /"output_format": "png"/,
    'transparent must force png on nano',
  );
  const rv = await run(['video', 'kling', 'x', '--transparent', '--dry-run']);
  assert.notStrictEqual(rv.code, 0, '--transparent on video must be rejected');
  const rnd = await run([
    'image',
    'x',
    '--transparent',
    '--no-download',
    '--dry-run',
  ]);
  assert.notStrictEqual(
    rnd.code,
    0,
    '--transparent with --no-download must be rejected (keying needs the file)',
  );
  if (sharpT) {
    // wait + transparent: rejoin path keys too; undecodable bytes degrade to a
    // warn, never a crash (dl000001's mock payload is not a real PNG)
    const dir = await mkdtemp(join(tmpdir(), 'snapgen-waitkey-'));
    const rw = await run(['wait', 'dl000001', '--transparent', '--out', dir], {
      ...env,
      SHARP_PATH: sharpDir,
    });
    assert.strictEqual(rw.code, 0, 'wait --transparent failed: ' + rw.out);
    assert.match(rw.out, /warn: keying failed/, 'bad bytes must warn, not die');
    assert.match(rw.out, /saved /, 'original must still be saved');
    await rm(dir, { recursive: true, force: true });
  }
  if (sharpT) {
    const dir = await mkdtemp(join(tmpdir(), 'snapgen-alpha-'));
    const r = await run(['image', 'ALPHATEST', '--transparent', '--out', dir], {
      ...env,
      SHARP_PATH: sharpDir, // hermetic cwd can't resolve sharp by walking up
    });
    assert.strictEqual(r.code, 0, 'transparent flow failed: ' + r.out);
    assert.match(r.out, /keyed .*-alpha\.png/, 'must report the keyed file');
    const { data, info } = await sharpT(
      join(dir, 'snapgen-alpha001-0-alpha.png'),
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.strictEqual(
      info.width,
      2,
      'magenta half must be trimmed away, got width ' + info.width,
    );
    for (let n = 0; n < info.width * info.height; n++)
      assert.strictEqual(data[n * 4 + 3], 255, 'subject must stay opaque');
    await rm(dir, { recursive: true, force: true });
  } else console.log('(sharp not resolvable — skipped live keying test)');
}

srv.close();
console.log('ALL TESTS PASS');
