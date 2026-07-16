#!/usr/bin/env node
// SnapGen (GeminiGen) API adapter — submit → poll → download. Zero deps.
// Auth: SNAPGEN_API_KEY env var (never printed). Docs: https://docs.snapgen.ai
//
//   node snapgen.mjs account
//   node snapgen.mjs image "prompt" --model nano-banana-2 [--aspect_ratio 3:2] [--resolution 2K] [--style Photorealistic] [--files a.png,b.png] [--file_urls u1,u2]
//   node snapgen.mjs gpt-image "prompt" [--mode low|medium|high] [--resolution 1K|2K|4K|8K|10K|12K] [--aspect_ratio 1:1] [--files ref.png]
//   node snapgen.mjs grok-image "prompt" [--mode SPEED|QUALITY] [--orientation landscape|portrait|square] [--num_result 1-8] [--files ref.png] [--ref_history <uuid>]
//   node snapgen.mjs meta-image "prompt" [--orientation landscape|portrait|square] [--num_result 1-4] [--files ref.png] [--ref_history <uuid>]
//   node snapgen.mjs video <veo|sora|grok|seedance|kling|meta> "prompt" --model <model> [--duration 8] [--resolution 720p] [--aspect_ratio 16:9] [--mode standard] [--ref_images a.png,https://…] ...
//   node snapgen.mjs extend <veo|grok|seedance|kling> "prompt" --ref_history <uuid> [--mode fast] [--duration N]
//   node snapgen.mjs storyboard '[{"prompt":"scene 1","duration":6,"mode":"custom"},...]' [--aspect_ratio landscape|portrait|square] [--resolution 480p|720p] [--files ...]
//     (scenes = JSON array, 2-10 scenes, <=45s total; scene N's last frame chains into scene N+1)
//   node snapgen.mjs status <uuid> | wait <uuid> | history [--filter_by image]
// Any extra --key value passes through as a form/query field.
// Flags: --dry-run (print request, send nothing)  --no-wait  --no-download  --out <dir>
//        --transparent (image cmds only: inject flat-magenta background, then
//        chroma-key the download to a real-alpha, subject-trimmed *-alpha.png;
//        needs sharp resolvable from cwd or SHARP_PATH — no API supports
//        native transparency, this is the reliable substitute)
import { openAsBlob, createWriteStream, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { basename, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SNAPGEN_BASE || 'https://api.snapgen.ai';
const POLL_MS = Number(process.env.SNAPGEN_POLL_MS || 5000);
const TIMEOUT_MS = Number(process.env.SNAPGEN_TIMEOUT_MS || 15 * 60_000);

// Key: env var, else auto-load from a .env in cwd or the skill root — the key
// value must never appear in argv, logs, or output. An env var that is SET
// (even to empty) wins and disables the dotenv fallback: callers like test
// harnesses set it to '' precisely to opt out of file-based keys, and falling
// through would let a stray .env make real billable requests.
function loadKey() {
  if ('SNAPGEN_API_KEY' in process.env) return process.env.SNAPGEN_API_KEY;
  const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const dir of [process.cwd(), skillRoot]) {
    try {
      const m = readFileSync(join(dir, '.env'), 'utf8').match(
        /^\s*SNAPGEN_API_KEY\s*=\s*"?([^"\r\n]+)"?\s*$/m,
      );
      if (m) return m[1].trim();
    } catch {} // ponytail: no .env here — try the next candidate
  }
  return '';
}
const KEY = loadKey();

const VIDEO_PATHS = {
  veo: 'video-gen/veo',
  sora: 'video-gen/sora',
  grok: 'video-gen/grok',
  seedance: 'video-gen/seedance',
  kling: 'video-gen/kling',
  meta: 'video-gen/meta',
};

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

// --- arg parsing: positionals then --key value pairs (booleans: --dry-run etc.)
const argv = process.argv.slice(2);
const pos = [];
const opts = {};
const BOOLS = new Set(['dry-run', 'no-wait', 'no-download', 'transparent']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (BOOLS.has(k)) opts[k] = true;
    else {
      const v = argv[++i];
      // guard: `--model --dry-run` must not eat the flag as a value (and
      // silently drop dry-run, turning a preview into a paid request)
      if (v === undefined || v.startsWith('--'))
        die(`--${k} needs a value (got ${v ?? 'nothing'})`);
      opts[k] = v;
    }
  } else pos.push(a);
}
const [cmd, ...rest] = pos;
if (!cmd)
  die(
    'usage: snapgen.mjs <account|image|gpt-image|grok-image|meta-image|video|extend|storyboard|status|wait|history> ... (see header comment)',
  );

const {
  'dry-run': dryRun,
  'no-wait': noWait,
  'no-download': noDownload,
  transparent,
  out: outDir = '.',
  ...fields
} = opts;

// --transparent: no SnapGen endpoint renders alpha (PNG is just the container),
// so generate on flat magenta and key it after download (see keyMagenta).
// Also valid on `wait <uuid>` to key a job submitted earlier with --no-wait.
if (transparent) {
  const IMG = ['image', 'gpt-image', 'grok-image', 'meta-image'];
  if (![...IMG, 'wait'].includes(cmd))
    die('--transparent only applies to image commands (or wait)');
  if (noDownload) die('--transparent needs the download — drop --no-download');
  if (IMG.includes(cmd)) {
    if (!/magenta|#ff00ff/i.test(rest.join(' ')))
      rest.push('with the entire background flat solid magenta #FF00FF');
    if (cmd === 'image' && !fields.output_format) fields.output_format = 'png';
  }
}

// Known closed enums (verified against the docs openapi.json, 2026-07).
// Warn-only typo guard before spending — the server stays authoritative.
const ENUMS = {
  image: {
    aspect_ratio: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    resolution: ['1K', '2K', '4K'],
    output_format: ['png', 'jpeg'],
  },
  'gpt-image': {
    aspect_ratio: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '3:2', '2:3'],
    mode: ['low', 'medium', 'high'],
    resolution: ['1K', '2K', '4K', '8K', '10K', '12K'],
  },
  'grok-image': {
    orientation: ['landscape', 'portrait', 'square'],
    mode: ['SPEED', 'QUALITY'],
  },
  'meta-image': { orientation: ['landscape', 'portrait', 'square'] },
  'video:veo': {
    aspect_ratio: ['16:9', '9:16'],
    resolution: ['720p', '1080p'],
    mode_image: ['frame', 'ingredient'],
    duration: ['4', '6', '8', '10'],
  },
  'video:sora': {
    resolution: ['small', 'large'],
    aspect_ratio: ['landscape', 'portrait'],
  },
  'video:seedance': {
    aspect_ratio: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'],
  },
  'video:grok': {
    aspect_ratio: ['landscape', 'portrait', 'square'],
    resolution: ['480p', '720p'],
    duration: ['6', '10', '15'],
  },
  'video:kling': {
    mode: [
      'standard',
      'professional',
      'professional_audio',
      'relax',
      'default',
    ],
  },
  'video:meta': { orientation: ['landscape', 'portrait', 'square'] },
  storyboard: {
    aspect_ratio: ['landscape', 'portrait', 'square'],
    resolution: ['480p', '720p'],
  },
};
{
  // Guard applies to generate commands only — extend endpoints have their own
  // param sets (e.g. extend kling/seedance mode defaults to "fast").
  const scope = cmd === 'video' ? `video:${rest[0]}` : cmd;
  for (const [k, allowed] of Object.entries(ENUMS[scope] ?? {})) {
    const v = fields[k];
    if (v !== undefined && !allowed.includes(String(v)))
      console.error(
        `warn: ${k}="${v}" is not a known ${scope} value (${allowed.join('|')}) — server may reject or coerce`,
      );
  }
}
if (!KEY && !dryRun)
  die(
    'SNAPGEN_API_KEY is not set. Set it in your environment first (never paste keys in chat).',
  );

async function api(method, path, { form, query } = {}) {
  const url = new URL(`${BASE}/uapi/v1/${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  if (dryRun) {
    // repeated multipart fields (files, ref_images, file_urls) accumulate
    // into arrays so the preview shows the EXACT request, not the last value
    const shown = {};
    if (form)
      for (const [k, v] of form.entries()) {
        const val = v instanceof Blob ? `<file>` : v;
        shown[k] = k in shown ? [].concat(shown[k], val) : val;
      }
    else Object.assign(shown, query ?? {});
    console.log(
      `[dry-run] ${method} ${url}\n${JSON.stringify(shown, null, 2)}`,
    );
    process.exit(0);
  }
  const res = await fetch(url, {
    method,
    headers: { 'x-api-key': KEY },
    body: form,
    // per-request deadline so waitDone's overall timeout can actually fire
    // (a hung socket would otherwise block inside fetch forever)
    signal: AbortSignal.timeout(
      Number(process.env.SNAPGEN_HTTP_TIMEOUT_MS || 120_000),
    ),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    die(
      `HTTP ${res.status} ${path}: ${JSON.stringify(data.detail ?? data).slice(0, 400)}`,
    );
  return data;
}

// Media keys: comma-split; local paths are blob-uploaded, but URL entries
// (veo/seedance accept URL strings) and bare UUIDs (grok video ref_images =
// history uuids) pass through as plain strings.
const UPLOAD_KEYS = new Set([
  'files',
  'ref_images',
  'ref_videos',
  'ref_audios',
]);
const isRemoteRef = (v) =>
  /^https?:\/\//i.test(v) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

async function buildForm(prompt, extra) {
  const form = new FormData();
  if (prompt) form.set('prompt', prompt);
  for (const [k, v] of Object.entries(extra)) {
    if (UPLOAD_KEYS.has(k))
      for (const f of v.split(',')) {
        const t = f.trim();
        if (isRemoteRef(t)) form.append(k, t);
        else form.append(k, await openAsBlob(t), basename(t));
      }
    else if (k === 'file_urls')
      for (const u of v.split(',')) form.append(k, u.trim());
    else form.set(k, v);
  }
  return form;
}

// Result URLs live in nested arrays (history detail) or top-level generate_result.
const resultUrls = (h) =>
  [
    ...(h.generated_image ?? []).map(
      (i) => i.file_download_url || i.image_url || i.image_uri,
    ),
    ...(h.generated_video ?? []).map((v) => v.video_url),
    ...(h.generated_audio ?? []).map((a) => a.file_download_url || a.audio_url),
    ...(h.generate_result ? [h.generate_result] : []),
  ].filter(Boolean);

// Chroma-key a downloaded render: magenta (min(R,B)-G keyness, per this
// repo's scripts/process-slab-frame.mjs) → alpha ramp + despill + 5×5 speckle
// cleanup, then trim to the subject's bounding box. Writes <file>-alpha.png.
// sharp is loaded lazily so the adapter keeps zero hard deps.
async function keyMagenta(file) {
  const { createRequire } = await import('node:module');
  const req = createRequire(join(process.cwd(), 'x.js'));
  let sharp;
  for (const p of [process.env.SHARP_PATH, 'sharp'].filter(Boolean)) {
    try {
      sharp = req(p);
      break;
    } catch {} // ponytail: try the next resolution candidate
  }
  if (!sharp)
    return console.error(
      'warn: sharp not resolvable from cwd (set SHARP_PATH=<dir>) — kept the opaque original, no -alpha.png',
    );
  try {
    await keyWithSharp(sharp, file);
  } catch (e) {
    console.error(`warn: keying failed (${e.message}) — kept the original`);
  }
}

async function keyWithSharp(sharp, file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const K0 = 0.15,
    K1 = 0.5,
    N = W * H;
  const alpha = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const i = n * 4;
    const k = Math.max(0, Math.min(data[i], data[i + 2]) - data[i + 1]) / 255;
    alpha[n] = k >= K1 ? 0 : k <= K0 ? 1 : (K1 - k) / (K1 - K0);
    if (k > 0) {
      // despill: subtract magenta excess so semi-transparent edges go neutral
      const e = Math.min(data[i], data[i + 2]) - data[i + 1];
      data[i] -= e;
      data[i + 2] -= e;
    }
  }
  const cleaned = new Float32Array(alpha);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const n = y * W + x;
      if (alpha[n] === 0 || alpha[n] >= 0.85) continue;
      let sum = 0,
        cnt = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
          sum += alpha[yy * W + xx];
          cnt++;
        }
      if (sum / cnt < 0.25) cleaned[n] = 0;
    }
  for (let n = 0; n < N; n++)
    data[n * 4 + 3] = Math.round(cleaned[n] * data[n * 4 + 3]);
  let sl = W,
    sr = -1,
    st = H,
    sb = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (data[(y * W + x) * 4 + 3] >= 25) {
        if (x < sl) sl = x;
        if (x > sr) sr = x;
        if (y < st) st = y;
        if (y > sb) sb = y;
      }
  if (sr < 0)
    return console.error(
      'warn: keying left no opaque pixels (was the render all magenta?) — kept the original only',
    );
  const out = file.replace(/\.[a-z0-9]+$/i, '') + '-alpha.png';
  await sharp(data, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: sl, top: st, width: sr - sl + 1, height: sb - st + 1 })
    .png()
    .toFile(out);
  console.log(`keyed ${out}`);
}

async function waitDone(uuid) {
  const t0 = Date.now();
  for (;;) {
    const h = await api('GET', `history/${uuid}`);
    if (h.status === 2) return h;
    if (h.status === 3)
      die(`FAILED ${uuid}: ${h.error_code ?? ''} ${h.error_message ?? ''}`);
    if (Date.now() - t0 > TIMEOUT_MS)
      die(
        `TIMEOUT ${uuid} after ${TIMEOUT_MS / 1000}s (still status ${h.status}, ${h.status_percentage ?? '?'}%)`,
      );
    process.stderr.write(`  …${h.status_percentage ?? 0}%\r`);
    await new Promise((ok) => setTimeout(ok, POLL_MS));
  }
}

async function finish(job) {
  console.log(
    `job ${job.uuid} submitted (estimated_credit: ${job.estimated_credit ?? '?'})`,
  );
  if (noWait) return console.log(`poll with: snapgen.mjs wait ${job.uuid}`);
  const h = await waitDone(job.uuid);
  const urls = resultUrls(h);
  console.log(`DONE (used_credit: ${h.used_credit ?? '?'})`);
  for (const u of urls) console.log(u);
  if (!urls.length)
    console.log(
      '(completed but no media URL — inspect: snapgen.mjs status ' +
        job.uuid +
        ')',
    );
  if (!noDownload && urls.length) {
    await mkdir(outDir, { recursive: true });
    for (const [i, u] of urls.entries()) {
      // stream to disk (videos can be large — never buffer whole bodies),
      // with a hard deadline so a stalled CDN can't hang the run
      const signal = AbortSignal.timeout(
        Number(process.env.SNAPGEN_DOWNLOAD_TIMEOUT_MS || 10 * 60_000),
      );
      const r = await fetch(u, { signal });
      if (!r.ok) {
        console.error(`download failed ${r.status}: ${u}`);
        continue;
      }
      const ext = extname(new URL(u).pathname) || '.bin';
      const file = join(outDir, `snapgen-${job.uuid.slice(0, 8)}-${i}${ext}`);
      await pipeline(Readable.fromWeb(r.body), createWriteStream(file), {
        signal,
      });
      console.log(`saved ${file}`);
      if (transparent) await keyMagenta(file);
    }
  }
}

switch (cmd) {
  case 'account': {
    const a = await api('GET', 'account');
    console.log(
      `plan: ${a.plan_id} | credits available: ${a.user_credit?.available_credit} (locked: ${a.user_credit?.locked_credit})`,
    );
    break;
  }
  case 'image':
    await finish(
      await api('POST', 'generate_image', {
        form: await buildForm(rest.join(' '), {
          model: 'nano-banana-2',
          ...fields,
        }),
      }),
    );
    break;
  case 'gpt-image':
    await finish(
      await api('POST', 'imagen/gpt-image-2', {
        form: await buildForm(rest.join(' '), fields),
      }),
    );
    break;
  case 'grok-image':
    await finish(
      await api('POST', 'imagen/grok', {
        form: await buildForm(rest.join(' '), fields),
      }),
    );
    break;
  case 'meta-image':
    await finish(
      await api('POST', 'meta_ai/generate', {
        form: await buildForm(rest.join(' '), fields),
      }),
    );
    break;
  case 'video': {
    const fam = rest.shift();
    const path =
      VIDEO_PATHS[fam] ??
      die(
        `unknown video family "${fam}" — use ${Object.keys(VIDEO_PATHS).join('|')}`,
      );
    await finish(
      await api('POST', path, {
        form: await buildForm(rest.join(' '), fields),
      }),
    );
    break;
  }
  case 'extend': {
    // Extend a previous video generation: extend <veo|grok|seedance|kling> "prompt" --ref_history <uuid>
    const fam = rest.shift();
    if (!VIDEO_PATHS[fam] || fam === 'meta' || fam === 'sora')
      die(`extend supports veo|grok|seedance|kling, not "${fam}"`);
    await finish(
      await api('POST', `video-extend/${fam}`, {
        form: await buildForm(rest.join(' '), fields),
      }),
    );
    break;
  }
  case 'storyboard':
    // Grok storyboard: positional arg is the required `scenes` field, not `prompt`
    await finish(
      await api('POST', 'video-storyboard/grok', {
        form: await buildForm(null, { scenes: rest.join(' '), ...fields }),
      }),
    );
    break;
  case 'status':
    console.log(
      JSON.stringify(await api('GET', `history/${rest[0]}`), null, 2),
    );
    break;
  case 'wait':
    await finish({ uuid: rest[0] });
    break;
  case 'history': {
    const h = await api('GET', 'histories', {
      query: { items_per_page: '10', page: '1', ...fields },
    });
    for (const r of h.result ?? [])
      console.log(
        `${r.uuid}  ${String(r.status_desc).padEnd(10)}  ${r.model_name}  ${String(r.input_text ?? '').slice(0, 60)}`,
      );
    break;
  }
  default:
    die(`unknown command "${cmd}"`);
}
