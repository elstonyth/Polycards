# Graded-Slab Dynamic Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the graded-slab frame with the SnapGen-generated one and render the PSA label per card (real grade, set, name, number, year, note) instead of the "GEM MINT 10" baked into the old frame image.

**Architecture:** The server-side bake (`bake-slab.ts`) gains a third composite layer — photo → frame → label SVG — rendered with a bundled Arimo font via fontconfig. Pure label logic (grade descriptors, name/set formatting, layout) lives in a new `label.ts` module. Two new operator-editable Card columns (`label_year`, `label_note`) flow through the existing create/update/rebake paths, and the admin gets fixed grader/grade dropdowns plus a pokemontcg.io prefill for year/rarity.

**Tech Stack:** Medusa v2 backend (TypeScript strict, jest unit tests, sharp/librsvg), Mercur admin (React + @medusajs/ui + vite), Next.js 16 storefront.

**Spec:** `docs/superpowers/specs/2026-07-16-graded-slab-dynamic-label-design.md` — section references (§N) below point there. Read it before starting.

## Global Constraints

- **`master` is branch-protected and the repo is PUBLIC.** All work happens on the feature branch created in Task 1; ship via PR. Before ANY push run `git log @{u}..HEAD 2>/dev/null` and inspect for commits you didn't make (epitaxy WIP-commit trap).
- **The working tree carries UNRELATED uncommitted slot-sound/reveal changes** (`src/lib/slot-sfx.ts`, `src/lib/vault-reel.ts`, `src/lib/rarity.ts`, `src/app/slots/[slug]/*`, `public/sounds/*`, `skills-lock.json`, `public/images/app/polycards-card-back.webp`). **Never `git add -A` / `git add .`** — every commit stages named files only.
- **Work in the main tree, not a worktree.** The feature depends on the uncommitted SSRF fix already in the tree (Task 1 commits it); a fresh worktree from `origin/master` would not have it and every local bake would silently fail (`bake-slab-localhost-ssrf-block` memory).
- **Casing is load-bearing (§8):** `setAbbrev` map values are emitted byte-verbatim (`POKEMON M2a JP`, never `M2A`); suffix tokens keep source casing (`PIKACHU ex`, `BLASTOISE EX`).
- **The set line is NEVER derived** from `ptcgoCode` or any API — mapped + fallback-to-uppercased-PC-name only (§7a/§8).
- **Grades:** PSA's 11-point scale exactly — `10, 9, 8, 7, 6, 5, 4, 3, 2, 1.5, 1`. No qualifier half-grades (2.5–9.5); 1.5 stays (§3a).
- **PSA-only bake (§9):** `grader === 'PSA'` bakes; every other grader renders the raw card (bake returns null).
- **The bake never fails a card save (§10):** any failure logs a warning and returns null.
- **Font must be bundled (§7):** Arimo via fontconfig; never rely on system Arial (absent on the Linux prod container).
- **`docs/research/` is gitignored** — deployable assets ship via `public/` + generated base64 TS modules (`medusa build` does not copy binary `src/` assets).
- **No PSA API calls, ever** (~1 req/day IP-wide throttle that extends on retry). pokemontcg.io is the only new network dependency: cached, 5s timeout, degrades to manual entry.
- Commands: storefront uses `npm` at the repo root; backend uses `corepack yarn` from `backend/packages/api`. Unit tests: `corepack yarn test:unit <spec path>`. Admin app: `corepack yarn build` from `backend/apps/admin`.
- TypeScript strict, no `any`, named exports, 2-space indent. Typecheck hooks run automatically on every `.ts`/`.tsx` edit — fix errors as they surface.
- Local infra for integration/rollout tasks: `pokenic-postgres` Docker container (DB user `medusa`, not `postgres`), backend `corepack yarn dev` on :9000.

---

### Task 1: Branch + commit the pre-existing slab work

The SSRF fix (33/33 tests green) and the design spec are **uncommitted working-tree state**. Nothing else in this plan works locally without the SSRF fix, and losing it would be expensive. No code changes in this task — only branch + commit of files that already exist.

**Files:**

- Commit (already modified/created, do not edit): `backend/packages/api/src/api/admin/media/bake-slab.ts`, `backend/packages/api/src/api/admin/media/__tests__/bake-slab.unit.spec.ts`, `docs/superpowers/specs/2026-07-16-graded-slab-dynamic-label-design.md`, `docs/superpowers/plans/2026-07-16-graded-slab-dynamic-label.md` (this file)

**Interfaces:**

- Produces: branch `feat/graded-slab-dynamic-label` containing the `localFileOrigin()` SSRF trust seam that all later bake runs depend on.

- [ ] **Step 1: Verify the tests still pass before committing**

Run from `backend/packages/api`:

```bash
corepack yarn test:unit src/api/admin/media/__tests__/bake-slab.unit.spec.ts
```

Expected: 33 passed.

- [ ] **Step 2: Branch off origin/master (working tree carries over)**

```bash
git fetch origin
git checkout -b feat/graded-slab-dynamic-label origin/master
```

Local master equals `origin/master` (verified 2026-07-16, no unpushed commits), so this preserves the uncommitted tree.

- [ ] **Step 3: Commit ONLY the named files**

```bash
git add backend/packages/api/src/api/admin/media/bake-slab.ts \
        backend/packages/api/src/api/admin/media/__tests__/bake-slab.unit.spec.ts \
        docs/superpowers/specs/2026-07-16-graded-slab-dynamic-label-design.md \
        docs/superpowers/plans/2026-07-16-graded-slab-dynamic-label.md
git status --short   # MUST still show the slot-sfx files as unstaged
git commit -m "fix(backend): trust local file origin in bake-slab SSRF guard; add slab dynamic-label spec + plan"
```

Expected: `git status --short` after commit still lists `src/lib/slot-sfx.ts` etc. as modified (unstaged) — they stay out of this branch's commits for the whole plan.

---

### Task 2: Process, measure, and ship the new frame asset

The SnapGen master (`docs/research/slabframe-snapgen-v2.png`, 3072×5504, local-only — the glare-free 2026-07-16 regeneration) becomes the shipped default frame. The green window and the white outside-background get keyed to transparent, the result is downscaled to 1600px and shipped both as `public/images/slab-frame.webp` and as the regenerated base64 module. Geometry constants move in lockstep (§5): the storefront renders every slab at `SLAB_ASPECT`, so frame and constant must change in the same commit.

**Files:**

- Create: `scripts/process-slabframe-v2.mjs`
- Overwrite: `public/images/slab-frame.webp` (currently the old 800×1338 frame)
- Regenerate: `backend/packages/api/src/api/admin/media/slab-frame-default.ts` (via existing `scripts/gen-slab-frame-module.mjs`)
- Modify: `backend/packages/api/src/api/admin/media/bake-slab.ts:23-28` (`SLAB_WINDOW`)
- Modify: `src/components/SlabImage.tsx:10` (`SLAB_ASPECT`)
- Modify: `backend/packages/api/src/api/admin/media/__tests__/bake-slab.unit.spec.ts:129-172` (window-inset constants in the composeSlab tests)

**Interfaces:**

- Consumes: `docs/research/slabframe-snapgen-v2.png` — the glare-free master regenerated via SnapGen on 2026-07-16 (nano-banana-2, reference-led off v1, "matte frosted clear case, soft even studio lighting", 3 credits). v1 carried painted white glare streaks over the window and highlight lines on the lip that no amount of post-processing fully removed. Must exist locally; if missing, stop and ask the operator — do NOT regenerate via SnapGen without approval.
- Produces: new `SLAB_WINDOW` values in `bake-slab.ts`; the script's printed `LABEL` box fractions (top/left/right/height of the frame) and holo probe, which Task 5 hardcodes as `LABEL_BOX`. Record all printed numbers in the commit message.

- [ ] **Step 1: Write the processing/measure script**

This is the verified pipeline from the design session (green key `g > r+18 && g > b+18`, tight ≥250 white flood-fill that stops at the (242,242,244) case body), promoted from scratchpad to a repo script. Create `scripts/process-slabframe-v2.mjs`:

```js
// Process the SnapGen slab-frame master into the shipped default frame:
// key the green card window + white outside background to transparent,
// downscale to 1600w, save public/images/slab-frame.webp, and print the
// measured geometry (window insets, label box, holo probe, alpha histogram).
// Usage: node scripts/process-slabframe-v2.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const sharp = require('sharp');

const SRC = path.join(
  here,
  '..',
  'docs',
  'research',
  'slabframe-snapgen-v2.png',
);
const OUT = path.join(here, '..', 'public', 'images', 'slab-frame.webp');
const TARGET_W = 1600; // = MAX_FRAME_WIDTH in bake-slab.ts

readFileSync(SRC); // fail fast if the local-only master is missing

// ---- 1. key green window + white outside background (on the 3072px master) ----
const { data, info } = await sharp(SRC)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const W = info.width,
  H = info.height,
  CH = info.channels;
const idx = (x, y) => (y * W + x) * CH;
for (let p = 0; p < W * H; p++) {
  const i = p * CH,
    r = data[i],
    g = data[i + 1],
    b = data[i + 2];
  if (g > r + 18 && g > b + 18 && g > 60 && g < 190) data[i + 3] = 0; // green window
}
// Outside-of-slab: flood from the border. Background is pure white; the case
// body is (242,242,244), so a tight >=250-on-all-channels test stops at the case.
const isBg = (x, y) => {
  const i = idx(x, y);
  return data[i] >= 250 && data[i + 1] >= 250 && data[i + 2] >= 250;
};
const seen = new Uint8Array(W * H);
const stack = [];
for (let x = 0; x < W; x++) stack.push(x, 0, x, H - 1);
for (let y = 0; y < H; y++) stack.push(0, y, W - 1, y);
while (stack.length) {
  const y = stack.pop(),
    x = stack.pop();
  if (x < 0 || y < 0 || x >= W || y >= H) continue;
  const p = y * W + x;
  if (seen[p] || !isBg(x, y)) continue;
  seen[p] = 1;
  data[p * CH + 3] = 0;
  stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
}

// ---- 2. verify by alpha histogram that the case body SURVIVED the fill (§4.3) ----
let casePx = 0;
for (let p = 0; p < W * H; p++) {
  const i = p * CH;
  if (
    data[i + 3] > 200 &&
    Math.abs(data[i] - 242) < 6 &&
    Math.abs(data[i + 1] - 242) < 6 &&
    Math.abs(data[i + 2] - 244) < 6
  )
    casePx++;
}
if (casePx < W * H * 0.02) {
  throw new Error(
    `case body eaten by the flood fill: only ${casePx} opaque case pixels`,
  );
}
console.log(
  'case-body opaque pixels:',
  casePx,
  `(${((casePx / (W * H)) * 100).toFixed(1)}% of frame)`,
);

// ---- 2b. clear-plastic case (operator request 2026-07-16): real PSA holders
// are translucent. Scale the alpha of every pixel UNIFORMLY except the label
// area (sticker + border + text background), which stays fully opaque.
// ⚠ Do NOT exempt a "recess ring" around the window: an opaque band there
// renders ~90 levels brighter than the glassy case over a dark page — it IS
// a glowing white outline around the card (debugged 2026-07-16 by pixel-
// walking the composite; the glow survived every art-side fix including a
// frame regeneration). Card overhang under the glass is prevented in
// composeSlab instead, by cropping the hidden columns (Step 5b).
// MUST run after the case-survival check above (which counts alpha>200) and
// before the downscale.
const CASE_ALPHA = 0.55; // glassy look — operator-tuned 2026-07-16
// label bbox (red border) on the master
let lrx0 = W,
  lry0 = H,
  lrx1 = -1,
  lry1 = -1;
for (let y = 0; y < Math.floor(H * 0.2); y++)
  for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    if (
      data[i + 3] > 200 &&
      data[i] > 140 &&
      data[i + 1] < 90 &&
      data[i + 2] < 90
    ) {
      if (x < lrx0) lrx0 = x;
      if (x > lrx1) lrx1 = x;
      if (y < lry0) lry0 = y;
      if (y > lry1) lry1 = y;
    }
  }
// window bbox on the master (interior transparent region — flood the exterior
// first, exactly like the measurement pass below)
{
  const ext2 = new Uint8Array(W * H);
  const st2 = [];
  for (let x = 0; x < W; x++) st2.push(x, 0, x, H - 1);
  for (let y = 0; y < H; y++) st2.push(0, y, W - 1, y);
  while (st2.length) {
    const y = st2.pop(),
      x = st2.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = y * W + x;
    if (ext2[p] || data[p * 4 + 3] > 8) continue;
    ext2[p] = 1;
    st2.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  let wx0 = W,
    wy0 = H,
    wx1 = -1,
    wy1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] <= 8 && !ext2[y * W + x]) {
        if (x < wx0) wx0 = x;
        if (x > wx1) wx1 = x;
        if (y < wy0) wy0 = y;
        if (y > wy1) wy1 = y;
      }
    }
  const labelPad = Math.round(W * 0.012);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (
        x >= lrx0 - labelPad &&
        x <= lrx1 + labelPad &&
        y >= lry0 - labelPad &&
        y <= lry1 + labelPad
      )
        continue;
      const i = idx(x, y);
      if (data[i + 3] === 0) continue;
      // de-glare: cap painted near-white highlight lines at the case tone (244)
      // — structure survives, the white pop doesn't. The label is exempt (its
      // sticker is genuinely white).
      const mn = Math.min(data[i], data[i + 1], data[i + 2]);
      if (mn > 244) {
        const f = 244 / mn;
        data[i] = Math.round(data[i] * f);
        data[i + 1] = Math.round(data[i + 1] * f);
        data[i + 2] = Math.round(data[i + 2] * f);
      }
      data[i + 3] = Math.round(data[i + 3] * CASE_ALPHA);
    }
  // ---- 2c. clear keying leftovers INSIDE the window: the SnapGen art paints
  // white glare streaks OVER the green window, and the green-key keeps them
  // (they aren't green). They float over the card as a "white line". The
  // opening must be pure glass — clear everything strictly inside it, sparing
  // only the rounded-corner lip zones.
  const inM = Math.round(W * 0.004);
  const cornerZone = Math.round(W * 0.03);
  for (let y = wy0 + inM; y <= wy1 - inM; y++) {
    const nearCY = y < wy0 + cornerZone || y > wy1 - cornerZone;
    for (let x = wx0 + inM; x <= wx1 - inM; x++) {
      const nearCX = x < wx0 + cornerZone || x > wx1 - cornerZone;
      if (nearCX && nearCY) continue; // window's rounded corner paint
      data[idx(x, y) + 3] = 0;
    }
  }
}

// ---- 3. downscale + ship ----
const keyed = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
  .resize({ width: TARGET_W, kernel: 'lanczos3' })
  .webp({ quality: 90, alphaQuality: 90 })
  .toBuffer();
await sharp(keyed).toFile(OUT);

// ---- 4. measure the shipped frame (never eyeball — §5) ----
const { data: D, info: I } = await sharp(OUT)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const w = I.width,
  h = I.height,
  ch = I.channels;
const A = (x, y) => D[(y * w + x) * ch + 3];
const RGB = (x, y) => {
  const i = (y * w + x) * ch;
  return [D[i], D[i + 1], D[i + 2]];
};
// exterior flood (transparent + border-connected), then window = interior transparent bbox
const ext = new Uint8Array(w * h);
const st = [];
for (let x = 0; x < w; x++) st.push(x, 0, x, h - 1);
for (let y = 0; y < h; y++) st.push(0, y, w - 1, y);
while (st.length) {
  const y = st.pop(),
    x = st.pop();
  if (x < 0 || y < 0 || x >= w || y >= h) continue;
  const p = y * w + x;
  if (ext[p] || A(x, y) > 8) continue;
  ext[p] = 1;
  st.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
}
let wx0 = w,
  wy0 = h,
  wx1 = -1,
  wy1 = -1;
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    if (A(x, y) <= 8 && !ext[y * w + x]) {
      if (x < wx0) wx0 = x;
      if (x > wx1) wx1 = x;
      if (y < wy0) wy0 = y;
      if (y > wy1) wy1 = y;
    }
  }
console.log('frame', `${w}x${h}`, 'SLAB_ASPECT', (w / h).toFixed(4));
console.log(
  'SLAB_WINDOW  top',
  (wy0 / h).toFixed(4),
  ' left',
  (wx0 / w).toFixed(4),
  ' right',
  ((w - 1 - wx1) / w).toFixed(4),
  ' bottom',
  ((h - 1 - wy1) / h).toFixed(4),
  ' window aspect',
  ((wx1 - wx0) / (wy1 - wy0)).toFixed(4),
);
// label = the WHITE STICKER inside the red border, top 20% of the frame.
// NOT the red outer bbox: all text constants are fractions of the sticker
// (measured 2026-07-16 on 4 real cert labels incl. cert 152108321 — the same
// Pikachu ex #238; using the red bbox pushed the right column outside the
// label). Off-centre scanlines so neither the border's rounded corners nor
// the centred PSA logo can truncate the walk.
const isRedAt = (x, y) => {
  const [r, g, b] = RGB(x, y);
  return A(x, y) > 200 && r > 140 && g < 90 && b < 90;
};
let lx0 = w,
  ly0 = h,
  lx1 = -1,
  ly1 = -1;
for (let y = 0; y < Math.floor(h * 0.2); y++)
  for (let x = 0; x < w; x++) {
    if (isRedAt(x, y)) {
      if (x < lx0) lx0 = x;
      if (x > lx1) lx1 = x;
      if (y < ly0) ly0 = y;
      if (y > ly1) ly1 = y;
    }
  }
const rowY = Math.round(ly0 + (ly1 - ly0) * 0.3); // crosses text at worst, never the logo
let sx0 = Math.round((lx0 + lx1) / 2);
while (sx0 > lx0 && !isRedAt(sx0 - 1, rowY)) sx0--;
let sx1 = Math.round((lx0 + lx1) / 2);
while (sx1 < lx1 && !isRedAt(sx1 + 1, rowY)) sx1++;
const colX = Math.round(lx0 + (lx1 - lx0) * 0.15); // left of the centred PSA logo
let sy0 = Math.round((ly0 + ly1) / 2);
while (sy0 > ly0 && !isRedAt(colX, sy0 - 1)) sy0--;
let sy1 = Math.round((ly0 + ly1) / 2);
while (sy1 < ly1 && !isRedAt(colX, sy1 + 1)) sy1++;
const STICKER = { x: sx0, y: sy0, w: sx1 - sx0 + 1, h: sy1 - sy0 + 1 };
console.log(
  'LABEL_BOX (white sticker)  top',
  (STICKER.y / h).toFixed(4),
  ' left',
  (STICKER.x / w).toFixed(4),
  ' right',
  ((w - STICKER.x - STICKER.w) / w).toFixed(4),
  ' height',
  (STICKER.h / h).toFixed(4),
);
// holo probe: the frame's baked-in PSA logo — dark ink bands inside the
// sticker (§13; text rows must stay above its top edge)
let hy0 = -1;
for (let y = sy0 + Math.floor(STICKER.h * 0.5); y <= sy1 && hy0 < 0; y++) {
  for (let x = sx0 + 3; x < sx1 - 3; x++) {
    const [r, g, b] = RGB(x, y);
    if (A(x, y) > 200 && Math.max(r, g, b) < 190) {
      hy0 = y;
      break;
    }
  }
}
if (hy0 >= 0) {
  console.log(
    'HOLO/logo top  frac-of-sticker',
    ((hy0 - sy0) / STICKER.h).toFixed(3),
    '(text baseline 3 sits at 0.723 — must be ABOVE this)',
  );
} else {
  console.log(
    'HOLO probe: no logo ink found in the sticker bottom half — inspect manually',
  );
}
```

- [ ] **Step 2: Run it and record the numbers**

```bash
node scripts/process-slabframe-v2.mjs
```

Expected (measured 2026-07-16 on the processed v2 master — trust the PRINTED values over these):
`SLAB_ASPECT 0.5581`, `SLAB_WINDOW top 0.2745 left 0.1069 right 0.1062 bottom 0.0778`, window aspect ≈ 0.678, `LABEL_BOX (white sticker) top 0.0474 left 0.0925 right 0.0938 height 0.1304` (this is the STICKER, deliberately smaller than the spec §5 red-border label box — see the geometry-correction note in Task 5), case-body pixels well above the 2% floor. The shipped webp's case must be glassy-translucent (alpha ≈ 55%) with the label area fully opaque — spot-check by compositing the frame over a dark background. NOTE: the measurement thresholds that require `A > 200` (label red, sticker scanlines) still work because the label region is exempt from the alpha scaling; the window/insets flood-fill uses `A ≤ 8`, far below the scaled case alpha (~140). If SLAB_WINDOW differs from the spec by more than ±0.005, re-check the source asset before proceeding. If the HOLO top fraction is ≤ 0.75, stop and flag to the operator — text baseline 3 (0.723) would collide with the logo.

- [ ] **Step 3: Regenerate the bundled default-frame module**

```bash
node scripts/gen-slab-frame-module.mjs
```

Expected: `wrote .../slab-frame-default.ts (~345000 base64 chars)` (precedent file was 325 KB — same order of magnitude is fine, §4.4).

- [ ] **Step 4: Update the geometry constants with the PRINTED values**

In `backend/packages/api/src/api/admin/media/bake-slab.ts` replace the `SLAB_WINDOW` block (keep the comment, add the provenance line):

```ts
// Card-window insets as fractions of the frame box, and the storefront clip's
// corner radii. Printed by scripts/process-slabframe-v2.mjs for the default
// frame asset; admin-uploaded frames must keep this geometry (PR #81 contract,
// mirrored in the admin Storefront page copy).
export const SLAB_WINDOW = {
  top: 0.2745,
  left: 0.1069,
  right: 0.1062,
  bottom: 0.0778,
} as const;
```

(Substitute the script's printed values if they differ.)

In `src/components/SlabImage.tsx` replace line 10 and its doc comment reference:

```ts
/**
 * Aspect ratio of the baked slab composite (= the frame asset it's baked
 * from — scripts/process-slabframe-v2.mjs prints it). Real PSA cases ≈ 0.62.
 */
export const SLAB_ASPECT = 3072 / 5504;
```

- [ ] **Step 5: Update the composeSlab geometry tests**

In `bake-slab.unit.spec.ts`, the `composeSlab` describe block hardcodes the OLD insets. Update the header comment and the two sampled positions:

```ts
// composeSlab geometry contract: output = frame-sized webp; the card photo
// covers the window rect (insets 27.43% / 10.61% / 7.76%); frame layers on top.
```

and in the first test replace the centre/label-row sampling with the new fractions:

```ts
// window centre → the red photo shows through the transparent frame
const cy = Math.round(669 * 0.2745 + (669 * (1 - 0.2745 - 0.0778)) / 2);
```

(the `t` sample at `669 * 0.1` stays valid — still above the window). Also update the second test's tall-frame height so the aspect matches the new frame: `makeFrame(3200, 5734)` (3200 / 0.5581 ≈ 5734).

- [ ] **Step 6: Run the tests**

```bash
corepack yarn test:unit src/api/admin/media/__tests__/bake-slab.unit.spec.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/process-slabframe-v2.mjs public/images/slab-frame.webp \
        backend/packages/api/src/api/admin/media/slab-frame-default.ts \
        backend/packages/api/src/api/admin/media/bake-slab.ts \
        backend/packages/api/src/api/admin/media/__tests__/bake-slab.unit.spec.ts \
        src/components/SlabImage.tsx
git commit -m "feat(slab): ship SnapGen frame v2 + measured geometry (SLAB_ASPECT 0.5581)

SLAB_WINDOW <printed values>; LABEL_BOX <printed values>; holo top <printed value>"
```

---

### Task 3: Pure label text logic (TDD)

The four derived-not-stored functions from §8, plus the grade-scale constant. All pure, no I/O — this is the module every later task consumes.

**Files:**

- Create: `backend/packages/api/src/api/admin/media/label.ts`
- Test: `backend/packages/api/src/api/admin/media/__tests__/label.unit.spec.ts`

**Interfaces:**

- Produces (exact signatures — Tasks 5–8 use these):
  - `PSA_GRADES: readonly ['10','9','8','7','6','5','4','3','2','1.5','1']`
  - `psaDescriptor(grade: string): string | null`
  - `parseCardName(product: string): { name: string; number: string }` (number includes the `#`, or `''`)
  - `formatCardName(name: string): string`
  - `setAbbrev(pcSetName: string): string`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/label.unit.spec.ts` (cases straight from §11):

```ts
import {
  PSA_GRADES,
  psaDescriptor,
  parseCardName,
  formatCardName,
  setAbbrev,
} from '../label';

describe('PSA_GRADES', () => {
  it("is exactly PSA's canonical 11-point scale — no qualifier half-grades, 1.5 present", () => {
    expect([...PSA_GRADES]).toEqual([
      '10',
      '9',
      '8',
      '7',
      '6',
      '5',
      '4',
      '3',
      '2',
      '1.5',
      '1',
    ]);
  });
});

describe('psaDescriptor', () => {
  it.each([
    ['10', 'GEM MT'],
    ['9', 'MINT'],
    ['8', 'NM-MT'],
    ['7', 'NM'],
    ['6', 'EX-MT'],
    ['5', 'EX'],
    ['4', 'VG-EX'],
    ['3', 'VG'],
    ['2', 'GOOD'],
    ['1.5', 'FR'],
    ['1', 'PR'],
  ])('grade %s → %s', (grade, desc) => {
    expect(psaDescriptor(grade)).toBe(desc);
  });

  it.each([
    ['unknown grade', 'A'],
    ['off-scale legacy 9.5', '9.5'],
    ['off-scale legacy 8.5', '8.5'],
    ['empty', ''],
  ])(
    'renders NO descriptor for %s (never assert a descriptor PSA would not use)',
    (_l, grade) => {
      expect(psaDescriptor(grade)).toBeNull();
    },
  );
});

describe('parseCardName', () => {
  it('splits a trailing #number', () => {
    expect(parseCardName('Pikachu ex #238')).toEqual({
      name: 'Pikachu ex',
      number: '#238',
    });
  });
  it('handles alphanumeric numbers', () => {
    expect(parseCardName('Trainer Card #SV43')).toEqual({
      name: 'Trainer Card',
      number: '#SV43',
    });
  });
  it('handles trailing spaces', () => {
    expect(parseCardName('  Mega Gengar ex #240  ')).toEqual({
      name: 'Mega Gengar ex',
      number: '#240',
    });
  });
  it('returns the whole name and empty number when there is no #', () => {
    expect(parseCardName('Charizard-Holo')).toEqual({
      name: 'Charizard-Holo',
      number: '',
    });
  });
});

describe('formatCardName', () => {
  it('uppercases but keeps a modern lowercase suffix verbatim', () => {
    expect(formatCardName('Pikachu ex')).toBe('PIKACHU ex');
  });
  it('keeps an old-era uppercase suffix verbatim', () => {
    expect(formatCardName('Blastoise EX')).toBe('BLASTOISE EX');
  });
  it('uppercases hyphenated names plainly', () => {
    expect(formatCardName('Charizard-Holo')).toBe('CHARIZARD-HOLO');
  });
  it('does NOT mangle a name merely containing a suffix substring', () => {
    expect(formatCardName('Exeggutor')).toBe('EXEGGUTOR');
  });
  it('handles multi-token names with a suffix', () => {
    expect(formatCardName('Mega Charizard X ex')).toBe('MEGA CHARIZARD X ex');
  });
});

describe('setAbbrev', () => {
  it.each([
    ['Pokemon Surging Sparks', 'POKEMON SSP EN'],
    ['Pokemon Phantasmal Flames', 'POKEMON PFL EN'],
    ['Pokemon Japanese Mega Dream ex', 'POKEMON M2a JP'],
  ])('maps %s → %s (verified against real slabs)', (pc, psa) => {
    expect(setAbbrev(pc)).toBe(psa);
  });

  it('returns a mapped value BYTE-IDENTICAL — mixed-case PSA codes survive', () => {
    // regression guard for PSA's mixed-case set codes: M2a, never M2A (§8)
    expect(setAbbrev('pokemon japanese mega dream ex')).toBe('POKEMON M2a JP');
    expect(setAbbrev('Pokemon Japanese Mega Dream ex')).not.toBe(
      'POKEMON M2A JP',
    );
  });

  it('falls back to the uppercased PC name for an unknown set — never a guessed code', () => {
    expect(setAbbrev('Pokemon Lost Origin')).toBe('POKEMON LOST ORIGIN');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
corepack yarn test:unit src/api/admin/media/__tests__/label.unit.spec.ts
```

Expected: FAIL — `Cannot find module '../label'`.

- [ ] **Step 3: Implement `label.ts` (part 1 — Task 5 appends the renderer)**

```ts
// Pure graded-slab label logic (spec 2026-07-16-graded-slab-dynamic-label §6/§8).
// No I/O here — the SVG renderer and layout join this module in a later task.

// PSA's canonical 11-point grade scale. Qualifier half-grades (2.5–9.5) are
// deliberately excluded (operator decision 2026-07-16): the catalog doesn't
// carry them and 9.5 is a PriceCharting price tier, never a PSA grade. 1.5
// stays — it is PSA's base FR grade, not a qualifier.
export const PSA_GRADES = [
  '10',
  '9',
  '8',
  '7',
  '6',
  '5',
  '4',
  '3',
  '2',
  '1.5',
  '1',
] as const;

// Verified against real slabs: PSA 7 → NM, 8 → NM-MT, 9 → MINT, 10 → GEM MT.
const PSA_DESCRIPTORS: Record<string, string> = {
  '10': 'GEM MT',
  '9': 'MINT',
  '8': 'NM-MT',
  '7': 'NM',
  '6': 'EX-MT',
  '5': 'EX',
  '4': 'VG-EX',
  '3': 'VG',
  '2': 'GOOD',
  '1.5': 'FR',
  '1': 'PR',
};

// Null for anything off-scale (legacy rows may hold e.g. 9.5): the grade
// number still prints, but the label must never assert a descriptor PSA
// wouldn't use.
export function psaDescriptor(grade: string): string | null {
  return PSA_DESCRIPTORS[grade.trim()] ?? null;
}

// PriceCharting embeds the card number in product-name ("Pikachu ex #238");
// no separate field exists.
export function parseCardName(product: string): {
  name: string;
  number: string;
} {
  const m = product.trim().match(/^(.*?)\s*#\s*([A-Za-z0-9/-]+)\s*$/);
  if (!m) return { name: product.trim(), number: '' };
  return { name: m[1].trim(), number: `#${m[2]}` };
}

// PSA prints PIKACHU ex, MEGA CHARIZARD X ex, BLASTOISE EX — uppercase every
// token EXCEPT a known suffix token, which is emitted verbatim from the
// source (source casing round-trips both TCG eras with no era table).
const SUFFIX_TOKENS = [
  'ex',
  'GX',
  'V',
  'VMAX',
  'VSTAR',
  'VUNION',
  'BREAK',
  'LV.X',
  'Prime',
  'LEGEND',
  'Star',
  'δ',
];

export function formatCardName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((tok) =>
      SUFFIX_TOKENS.some((s) => s.toLowerCase() === tok.toLowerCase())
        ? tok
        : tok.toUpperCase(),
    )
    .join(' ');
}

// PSA abbreviates sets; PriceCharting does not. Keyed on the normalised PC
// console-name INCLUDING its language marker ("Pokemon Japanese …") — an
// Italian printing must never inherit the English mapping. Values are PSA's
// verbatim printed line (verified against real slabs) and are emitted
// BYTE-IDENTICAL — mixed-case codes like M2a are load-bearing. NEVER derive
// these from ptcgoCode (§7a). A new set needs a new verified entry — the
// accepted maintenance cost of the map over an editable set field. Additional
// verified rows live in docs/research/psa-set-prefill.json (local-only);
// only rows verified against a real slab or PSA's own listing may be added.
const SET_ABBREV: Record<string, string> = {
  'pokemon surging sparks': 'POKEMON SSP EN', // Pikachu ex #238 slab
  'pokemon phantasmal flames': 'POKEMON PFL EN', // Mega Charizard X ex #125 slab
  'pokemon japanese mega dream ex': 'POKEMON M2a JP', // Mega Gengar ex #240 slab
};

// Unknown set → uppercased PC name (accurate, just not PSA's wording).
export function setAbbrev(pcSetName: string): string {
  const key = pcSetName.trim().toLowerCase().replace(/\s+/g, ' ');
  return SET_ABBREV[key] ?? pcSetName.trim().toUpperCase();
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
corepack yarn test:unit src/api/admin/media/__tests__/label.unit.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/api/admin/media/label.ts \
        backend/packages/api/src/api/admin/media/__tests__/label.unit.spec.ts
git commit -m "feat(slab): pure label logic — psaDescriptor, parseCardName, formatCardName, setAbbrev"
```

---

### Task 4: Bundle the Arimo font (production-critical, §7)

Arial doesn't exist on the Linux prod container; without a bundled font the bake silently falls back to DejaVu Sans. Ship Arimo (Apache 2.0, Arial-metric) as a base64 TS module (same pattern as the frame — `medusa build` copies no binary src assets) and register it via a generated fontconfig at runtime.

**Files:**

- Create: `public/fonts/Arimo-Variable.ttf` (downloaded; git-tracked like Nekst)
- Create: `scripts/gen-arimo-font-module.mjs`
- Create: `backend/packages/api/src/api/admin/media/arimo-font-b64.ts` (generated)
- Create: `backend/packages/api/src/api/admin/media/label-font.ts`
- Test: `backend/packages/api/src/api/admin/media/__tests__/label-font.unit.spec.ts`

**Interfaces:**

- Produces: `ensureLabelFont(): void` (idempotent; MUST run before the first text render in the process) and `LABEL_FONT_FAMILY = 'Arimo'` — Task 5's renderer and Task 7's bake call these.

- [ ] **Step 1: Download Arimo (Apache 2.0) into public/fonts**

```bash
curl -L -o public/fonts/Arimo-Variable.ttf "https://github.com/google/fonts/raw/main/apache/arimo/Arimo%5Bwght%5D.ttf"
ls -l public/fonts/Arimo-Variable.ttf
```

Expected: a TTF of roughly 400–600 KB. Sanity-check the magic bytes: `head -c 4 public/fonts/Arimo-Variable.ttf | xxd` should show `0001 0000` (TrueType). If the URL 404s, fetch the Arimo family zip from fonts.google.com and use the variable TTF from it — do not substitute a different typeface.

- [ ] **Step 2: Write the generator script**

Create `scripts/gen-arimo-font-module.mjs` (mirrors `gen-slab-frame-module.mjs`):

```js
// Regenerate the backend's bundled Arimo font module from
// public/fonts/Arimo-Variable.ttf. Shipped as a TS module because
// `medusa build` does not copy binary src/ assets into the deployed bundle.
// Usage: node scripts/gen-arimo-font-module.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'public', 'fonts', 'Arimo-Variable.ttf');
const out = path.join(
  here,
  '..',
  'backend',
  'packages',
  'api',
  'src',
  'api',
  'admin',
  'media',
  'arimo-font-b64.ts',
);
const b64 = readFileSync(src).toString('base64');
writeFileSync(
  out,
  '// GENERATED by scripts/gen-arimo-font-module.mjs — do not edit by hand.\n' +
    '// Base64 of public/fonts/Arimo-Variable.ttf (Arimo, Apache 2.0 —\n' +
    '// Arial/Helvetica-metric). Bundled because Arial does not exist on the\n' +
    '// Linux prod container and a DejaVu fallback ships wrong label metrics.\n' +
    '// eslint-disable-next-line max-len\n' +
    `export const ARIMO_FONT_B64 =\n  '${b64}';\n`,
);
console.log(`wrote ${out} (${b64.length} base64 chars)`);
```

Run it: `node scripts/gen-arimo-font-module.mjs`.

- [ ] **Step 3: Write the runtime registration module**

Create `backend/packages/api/src/api/admin/media/label-font.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ARIMO_FONT_B64 } from './arimo-font-b64';

export const LABEL_FONT_FAMILY = 'Arimo';

let installed = false;

// Materialise the bundled Arimo TTF + a minimal fontconfig into the OS temp
// dir and point fontconfig at it, so sharp/librsvg (pango) resolve 'Arimo'
// deterministically on dev AND the Linux prod container (which has no Arial).
// MUST run before the first <text> render in this process — fontconfig reads
// FONTCONFIG_PATH once, lazily, at first text layout. bakeSlabImage calls
// this before composing; the earlier mask SVGs contain no text.
export function ensureLabelFont(): void {
  if (installed) return;
  const dir = path.join(tmpdir(), 'polycards-label-font');
  const cacheDir = path.join(dir, 'cache');
  const fontPath = path.join(dir, 'Arimo-Variable.ttf');
  const confPath = path.join(dir, 'fonts.conf');
  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(fontPath)) {
    writeFileSync(fontPath, Buffer.from(ARIMO_FONT_B64, 'base64'));
  }
  writeFileSync(
    confPath,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${dir}</dir>\n  <cachedir>${cacheDir}</cachedir>\n</fontconfig>\n`,
  );
  process.env.FONTCONFIG_PATH = dir;
  process.env.FONTCONFIG_FILE = confPath;
  installed = true;
}
```

- [ ] **Step 4: Write the font-verification test (fails on a DejaVu fallback)**

Create `__tests__/label-font.unit.spec.ts`:

```ts
import sharp from 'sharp';
import { ensureLabelFont, LABEL_FONT_FAMILY } from '../label-font';

// §7: assert rendered metrics of a known string so a font regression fails a
// test instead of shipping. W-vs-i ink-width ratio separates Arial-metric
// Arimo (~4.2) from the DejaVu Sans fallback (~3.3) far outside noise.
const inkWidth = async (text: string): Promise<number> => {
  const svg = Buffer.from(
    `<svg width="4000" height="300" xmlns="http://www.w3.org/2000/svg">` +
      `<text x="10" y="200" font-family="${LABEL_FONT_FAMILY}" font-size="100">${text}</text></svg>`,
  );
  const { info } = await sharp(svg)
    .trim()
    .toBuffer({ resolveWithObject: true });
  return info.width;
};

describe('bundled label font', () => {
  beforeAll(() => ensureLabelFont());

  it('resolves Arimo (Arial metrics), not a DejaVu fallback', async () => {
    const w = await inkWidth('WWWWWWWWWW');
    const i = await inkWidth('iiiiiiiiii');
    expect(w / i).toBeGreaterThan(3.8);
  });
});
```

- [ ] **Step 5: Run it**

```bash
corepack yarn test:unit src/api/admin/media/__tests__/label-font.unit.spec.ts
```

Expected: PASS. If the ratio assertion fails, print both widths, confirm by eye (render the SVG to a PNG and Read it) whether Arimo actually resolved; adjust the threshold only if Arimo is genuinely rendering and the measured ratio sits elsewhere — then pin the measured value ±10%.

- [ ] **Step 6: Commit**

```bash
git add public/fonts/Arimo-Variable.ttf scripts/gen-arimo-font-module.mjs \
        backend/packages/api/src/api/admin/media/arimo-font-b64.ts \
        backend/packages/api/src/api/admin/media/label-font.ts \
        backend/packages/api/src/api/admin/media/__tests__/label-font.unit.spec.ts
git commit -m "feat(slab): bundle Arimo label font + fontconfig runtime registration"
```

---

### Task 5: Label layout + SVG renderer + composeSlab label layer (TDD)

The measured layout from §6: three shared baselines, left column left-aligned, right column right-aligned, every element the same size and weight 500 (the name is NOT larger; the grade is NOT a big number). Layout is a pure function so geometry is unit-testable without rasterising.

> **Geometry correction (2026-07-16, supersedes the spec §6 numbers):** the spec's
> fractions (baselines 0.365/0.539/0.719, cap 0.117 of height, left 0.068, right
> 0.994) were measured against a differently-defined box and push the right column
> onto/past the label border when applied to the frame's red-bbox (verified on a
> rendered preview). The constants below were re-measured on **4 real PSA cert
> label photos** (`docs/research/psa-labels/`, incl. cert 152108321 — the identical
> Pikachu ex #238) as fractions of the **white sticker**, and the cap height is
> bound to sticker **WIDTH** (the binding constraint — the generated sticker is
> proportionally taller than a real one, so a height-bound cap oversizes the text).
> Cross-cert spread: baselines ±0.02, cap 0.030–0.037 (modern certs at the low
> end), left 0.026–0.037, right end 0.963–0.974. Comparison render:
> `docs/research/preview-real-vs-baked.png`.
>
> **Card-fit + case-look decisions (operator-iterated to v13, 2026-07-16, FINAL):**
> the card image is used AS-IS — the operator's hard requirement is "the original
> image with the trimmed-out corners and the blacks removed, do not overtrim":
>
> - `cleanScan` is the operator-specified crop system: alpha binarize (<250 → 0),
>   exact content bbox, a TINY per-side bright-ring peel (max 3px) + 1px
>   anti-alias contact ring, then a corner re-cut at the real Pokémon die-cut
>   radius (4.76% of width, circular — same angle, same curve) that removes the
>   scan's white arc fringe. Over-trim hard-fails at >4px per side. Verified
>   over magenta: docs/research/verify-clean-card.png / verify-clean-corner.png.
> - The WHOLE card sits inside the window at natural aspect — width-fit with a
>   thin recess inset (~0.63% of window width), snug at the TOP under the
>   label rail (real-slab orientation, verified on a high-res eBay sale photo
>   of the identical PSA-10 slab fetched via PriceCharting's sales table —
>   the earlier bottom-anchored layout came from a misleading 380px PSA cert
>   photo). Nothing
>   is cropped or distorted; the die-cut corner curves show in full. The pocket
>   above the card is closed with a case-tone GLASSY band (fill 197 @ 55% +
>   molded lip line) that blends with the uniformly glassy case (pixel-verified
>   115 vs 117). Supersedes the spec §5 "~5% horizontal crop, accepted". NOTE:
>   a band was once rejected as "white lighting" — that failure was caused by
>   the opaque recess ring around it, not the band; with the uniform glassy
>   case it blends. A height-fit variant that cropped the side overhang was
>   also rejected (over-cropped the cut).
> - The die-cut corner curves stay visible at all four corners; the corner
>   cutouts, recess gap, and pocket show the glassy SHADOWED-RECESS plate
>   behind the card (tone 148 @ 55% → recess ~87 vs case ~115 over a dark
>   page, matching the real slab's darker molded interior). Raw transparency
>   there ("black tips") and a case-bright plate (cut looked wrong-sized)
>   were both rejected.
> - The case is UNIFORMLY glassy (alpha 55% — Task 2 §2b); ONLY the label stays
>   opaque. An "opaque recess ring" around the window was the final debugged
>   cause of the persistent "white glare": it rendered ~90 levels brighter
>   than the glassy case over a dark page, a glowing outline hugging the card
>   (pixel-walk evidence 2026-07-16: ring 180–196 vs case 108–124). Never
>   exempt it again.
> - The frame's window interior is CLEARED of keying leftovers (Task 2 §2c):
>   the SnapGen art painted white glare streaks over the green window and the
>   green-key kept them — they floated over the card as a "white line".
> - The whole non-label frame is DE-GLARED (Task 2 §2b clamp): painted
>   near-white highlight lines on the lip/case (full-width bands measured just
>   above and below the window) are capped at the case tone (244). Verify by
>   rescanning: zero rows outside the label may have >30 pixels with
>   min(r,g,b) > 246 at alpha > 100.
>   Rejected along the way (do not re-propose): cover-crop fill; a NEAR-OPAQUE
>   backplate (v5 — the glassy tone-matched plate above is the working version);
>   window-based corner masks; row-shave trims beyond the tiny peel; four-sided
>   overscan hiding the corners; height-fit that crops the side overhang; an
>   OPEN pocket above the card; raw transparency in the recess gap/corner
>   cutouts; an opaque recess ring around the window (the debugged "white
>   glare" glow).
>   Reference renders (operator-approved): docs/research/preview-baked-slabs-v27.png
>   (v25 + case-tone corner patches) plus the real-vs-ours proof
>   docs/research/real-ebay-vs-v25.png,
>   built on the regenerated master (slabframe-snapgen-v2.png, SnapGen 2026-07-16)
>   processed into docs/research/slabframe-final-1600.png (exact 1600×2867;
>   window geometry within 1px of v1, so no constant churn beyond the values
>   recorded in Tasks 2/5).

**Files:**

- Modify: `backend/packages/api/src/api/admin/media/label.ts` (append layout + renderer)
- Modify: `backend/packages/api/src/api/admin/media/bake-slab.ts:209-254` (`composeSlab` gains the optional label layer)
- Test: `backend/packages/api/src/api/admin/media/__tests__/label.unit.spec.ts` (append), `bake-slab.unit.spec.ts` (append)

**Interfaces:**

- Consumes: `parseCardName`, `formatCardName`, `setAbbrev`, `psaDescriptor` (Task 3); `ensureLabelFont`, `LABEL_FONT_FAMILY` (Task 4); `LABEL_BOX` fractions printed by Task 2.
- Produces (Task 7 uses these):
  - `SlabLabelFields = { set: string; name: string; grade: string; year?: string | null; note?: string | null }` (raw card values — the layout derives number/descriptor/casing itself)
  - `LabelRun = { x: number; y: number; fontSize: number; anchor: 'start' | 'end'; text: string }`
  - `layoutLabel(f: SlabLabelFields, box: { x: number; y: number; w: number; h: number }): LabelRun[]`
  - `renderLabelSvg(f: SlabLabelFields, frameW: number, frameH: number): Buffer`
  - `composeSlab(frameBytes, photoBytes, label?: SlabLabelFields)` — 2-arg calls keep today's behaviour.

- [ ] **Step 1: Write the failing layout tests (append to `label.unit.spec.ts`)**

```ts
import { layoutLabel, type SlabLabelFields } from '../label';

describe('layoutLabel', () => {
  const box = { x: 100, y: 120, w: 1000, h: 278 };
  const fields: SlabLabelFields = {
    set: 'Pokemon Surging Sparks',
    name: 'Pikachu ex #238',
    grade: '10',
    year: '2024',
    note: 'SPECIAL ILLUSTRATION RARE',
  };

  it('lands all rows on the three measured baselines (0.298 / 0.509 / 0.723)', () => {
    const runs = layoutLabel(fields, box);
    const ys = [...new Set(runs.map((r) => r.y))].sort((a, b) => a - b);
    expect(ys).toEqual([
      Math.round(120 + 278 * 0.298),
      Math.round(120 + 278 * 0.509),
      Math.round(120 + 278 * 0.723),
    ]);
  });

  it('renders year inline on line 1 and derives every printed value', () => {
    const runs = layoutLabel(fields, box);
    const texts = runs.map((r) => r.text);
    expect(texts).toContain('2024 POKEMON SSP EN');
    expect(texts).toContain('PIKACHU ex');
    expect(texts).toContain('SPECIAL ILLUSTRATION RARE');
    expect(texts).toContain('#238');
    expect(texts).toContain('GEM MT');
    expect(texts).toContain('10');
  });

  it('blank year: set starts at the left margin — no orphan indent, no shift', () => {
    const runs = layoutLabel({ ...fields, year: null }, box);
    const line1 = runs.find((r) => r.text === 'POKEMON SSP EN');
    expect(line1).toBeDefined();
    expect(line1!.x).toBe(Math.round(100 + 1000 * 0.032));
  });

  it('blank note: renders no third-left-row run and no layout shift elsewhere', () => {
    const withNote = layoutLabel(fields, box);
    const without = layoutLabel({ ...fields, note: null }, box);
    expect(without.map((r) => r.text)).not.toContain(
      'SPECIAL ILLUSTRATION RARE',
    );
    const name = (runs: typeof withNote) =>
      runs.find((r) => r.text === 'PIKACHU ex')!;
    expect(name(without)).toEqual(name(withNote));
  });

  it('every element is the same size and none overlaps the right column', () => {
    const runs = layoutLabel(fields, box);
    const sizes = new Set(runs.map((r) => r.fontSize));
    expect(sizes.size).toBe(1); // §6: name not larger, grade not a big number
  });

  it('shrinks a long left line rather than overlapping the right column', () => {
    const long = layoutLabel(
      {
        ...fields,
        name: 'Some Extremely Long Promotional Card Name That Overflows ex #238',
      },
      box,
    );
    const nameRun = long.find(
      (r) => r.anchor === 'start' && r.text.startsWith('SOME'),
    )!;
    const base = layoutLabel(fields, box).find((r) => r.text === 'PIKACHU ex')!;
    expect(nameRun.fontSize).toBeLessThan(base.fontSize);
    expect(nameRun.fontSize).toBeGreaterThanOrEqual(base.fontSize * 0.7);
  });

  it('off-scale grade: number still prints, descriptor row is absent', () => {
    const runs = layoutLabel({ ...fields, grade: '9.5' }, box);
    expect(runs.map((r) => r.text)).toContain('9.5');
    expect(runs.map((r) => r.text)).not.toContain('GEM MT');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
corepack yarn test:unit src/api/admin/media/__tests__/label.unit.spec.ts
```

Expected: FAIL — `layoutLabel is not a function`.

- [ ] **Step 3: Append layout + renderer to `label.ts`**

Substitute the `LABEL_BOX` values Task 2 printed:

```ts
import { LABEL_FONT_FAMILY } from './label-font';

// ---------------------------------------------------------------------------
// Layout + SVG renderer (spec §6, geometry re-measured 2026-07-16 on 4 real
// PSA cert label photos — docs/research/psa-labels/, incl. cert 152108321,
// the identical Pikachu ex #238). All fractions are of the label's WHITE
// STICKER (not the red outer border), and the cap height is bound to sticker
// WIDTH — the generated sticker is proportionally taller than a real one, so
// a height-bound cap oversizes the text and overruns the border.
// ---------------------------------------------------------------------------

export type SlabLabelFields = {
  set: string; // PriceCharting console-name, e.g. "Pokemon Surging Sparks"
  name: string; // raw card name, may embed "#238"
  grade: string;
  year?: string | null;
  note?: string | null;
};

// White-sticker box as fractions of the FRAME — printed by
// scripts/process-slabframe-v2.mjs for the shipped frame (Task 2).
export const LABEL_BOX = {
  top: 0.0474,
  left: 0.0925,
  right: 0.0938,
  height: 0.1304,
} as const;

const BASELINES = [0.298, 0.509, 0.723] as const; // of sticker height (4-cert mean)
const CAP_OF_WIDTH = 0.033; // cap height / sticker WIDTH (4-cert mean, 0.030–0.037)
const LEFT_MARGIN = 0.032; // of sticker width
const RIGHT_EDGE = 0.968; // of sticker width — real labels end 0.963–0.974, never ~1
const ARIMO_CAP_PER_EM = 0.716; // Arimo/Arial capHeight ÷ unitsPerEm
const COL_GAP_FRAC = 0.02; // min gap between columns, of label-box width
const MIN_SHRINK = 0.7; // shrink-to-fit floor before ellipsizing (§10)
// ponytail: flat per-char advance estimate for uppercase Arimo — good enough
// to keep columns apart; swap for real pango measurement if it ever misfits.
const AVG_CHAR_PER_EM = 0.6;
const ELLIPSIS = '…';

export type LabelRun = {
  x: number;
  y: number;
  fontSize: number;
  anchor: 'start' | 'end';
  text: string;
};

const estWidth = (text: string, fontSize: number): number =>
  text.length * fontSize * AVG_CHAR_PER_EM;

// Pure layout: three shared baselines, left column left-aligned, right column
// right-aligned, EVERY element the same size + weight (§6 — verified against
// the reference; an earlier draft that emphasised name/grade was measurably
// wrong). A left line that would collide with the right column shrinks to a
// floor, then ellipsizes — never overlaps (§10).
export function layoutLabel(
  f: SlabLabelFields,
  box: { x: number; y: number; w: number; h: number },
): LabelRun[] {
  const { name, number } = parseCardName(f.name);
  const year = (f.year ?? '').trim();
  const note = (f.note ?? '').trim();
  const grade = f.grade.trim();
  const left = [
    [year, setAbbrev(f.set)].filter(Boolean).join(' '),
    formatCardName(name),
    note,
  ];
  const right = [number, psaDescriptor(grade) ?? '', grade];

  const baseFs = (box.w * CAP_OF_WIDTH) / ARIMO_CAP_PER_EM;
  const leftX = Math.round(box.x + box.w * LEFT_MARGIN);
  const rightX = Math.round(box.x + box.w * RIGHT_EDGE);
  const runs: LabelRun[] = [];

  for (let i = 0; i < 3; i++) {
    const y = Math.round(box.y + box.h * BASELINES[i]);
    if (right[i] !== '') {
      runs.push({
        x: rightX,
        y,
        fontSize: baseFs,
        anchor: 'end',
        text: right[i],
      });
    }
    if (left[i] === '') continue;
    const rightW =
      right[i] === '' ? 0 : estWidth(right[i], baseFs) + box.w * COL_GAP_FRAC;
    const maxW = rightX - rightW - leftX;
    let fs = baseFs;
    let text = left[i];
    if (estWidth(text, fs) > maxW) {
      const fitted = (maxW / estWidth(text, baseFs)) * baseFs;
      fs = Math.max(baseFs * MIN_SHRINK, fitted);
      if (fs > fitted) {
        // clamped at the floor — ellipsize down to fit
        while (text.length > 1 && estWidth(text + ELLIPSIS, fs) > maxW) {
          text = text.slice(0, -1);
        }
        text += ELLIPSIS;
      }
    }
    runs.push({ x: leftX, y, fontSize: fs, anchor: 'start', text });
  }
  return runs;
}

const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Frame-sized SVG carrying only the label text — composited at (0,0) over
// the frame by composeSlab. Weight 500, letter-spacing 1% of the em, near-
// black ink, all matching the measured reference.
export function renderLabelSvg(
  f: SlabLabelFields,
  frameW: number,
  frameH: number,
): Buffer {
  const box = {
    x: Math.round(frameW * LABEL_BOX.left),
    y: Math.round(frameH * LABEL_BOX.top),
    w: Math.round(frameW * (1 - LABEL_BOX.left - LABEL_BOX.right)),
    h: Math.round(frameH * LABEL_BOX.height),
  };
  const runs = layoutLabel(f, box);
  const texts = runs
    .map(
      (r) =>
        `<text x="${r.x}" y="${r.y}" font-size="${r.fontSize.toFixed(1)}" ` +
        `letter-spacing="${(r.fontSize * 0.01).toFixed(2)}"` +
        `${r.anchor === 'end' ? ' text-anchor="end"' : ''}>${escXml(r.text)}</text>`,
    )
    .join('');
  return Buffer.from(
    `<svg width="${frameW}" height="${frameH}" xmlns="http://www.w3.org/2000/svg">` +
      `<g font-family="${LABEL_FONT_FAMILY}" font-weight="500" fill="#1a1a1a">${texts}</g></svg>`,
  );
}
```

- [ ] **Step 4: Run the layout tests**

```bash
corepack yarn test:unit src/api/admin/media/__tests__/label.unit.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Wire the label layer into `composeSlab`**

In `bake-slab.ts`, add imports and the third layer:

```ts
import { renderLabelSvg, type SlabLabelFields } from './label';
import { ensureLabelFont } from './label-font';
```

Change the `composeSlab` signature and final composite (the function is otherwise unchanged):

```ts
// Pure composite: photo cover-fitted into the frame's card window (corners
// rounded like the old storefront clip), frame layered on top, then the
// per-card PSA label text (photo → frame → label, spec §6). No label fields →
// today's two-layer behaviour (used by geometry tests and any raw composite).
export async function composeSlab(
  frameBytes: Buffer,
  photoBytes: Buffer,
  label?: SlabLabelFields,
): Promise<Buffer> {
```

and replace the `.composite([...])` call:

```ts
// The glassy case `plate` (Step 5b) sits behind the card across the whole
// window: pocket, recess gap, and corner cutouts all read as case plastic.
const layers: sharp.OverlayOptions[] = [
  { input: plate, left, top },
  { input: photo, left: cardLeft, top: cardTop },
  { input: frame, left: 0, top: 0 },
];
if (label) {
  ensureLabelFont(); // must precede the first text render in this process
  layers.push({ input: renderLabelSvg(label, fw, fh), left: 0, top: 0 });
}
return sharp({
  create: {
    width: fw,
    height: fh,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(layers)
  .webp({ quality: 90, alphaQuality: 90 })
  .toBuffer();
```

- [ ] **Step 5b: Real-slab card fitting in `composeSlab` (same file)**

**Final card-handling contract (operator-specified crop system, v14, 2026-07-16):** the card content is preserved intact — only the tiny white matting edge is peeled (≤3px + 1px anti-alias ring, hard-fail above 4px/side) and the corners are re-cut at the real Pokémon die-cut curve (4.76% of width, circular, fully transparent outside the arc). No side crop, no distortion. Earlier variants (row-shave trims, window-based masks, cover-crop, overscan-under-lip) were each built and rejected for over-trimming the card.

Replace the photo-fitting block (currently: `fit: 'cover'` into the full window with the window-based `CORNER_RX`/`CORNER_RY` mask). Delete the `CORNER_RX`/`CORNER_RY` constants and add above `composeSlab`:

```ts
// Card-scan crop system (operator-specified, rebuilt 2026-07-16, verified on
// magenta — docs/research/verify-clean-card.png):
//   1. scan the white edge and peel the TINY edge only: per-side bright-ring
//      peel (max 3px) + one unconditional 1px anti-alias contact ring;
//   2. re-cut the corners to a real Pokémon die-cut (r = 4.76% of width,
//      circular — same angle, same curve), cutting INSIDE the scan's own
//      fringed arc so its white anti-alias line goes with it;
//   3. the "white bright layer" is opaque white matting on the arcs/edges —
//      alpha-binarize alone cannot catch it (those pixels are opaque); the
//      peel + arc re-cut remove it;
//   4. verify: the bright-peel rule (min(r,g,b) > 200 for >=60% of a ring)
//      can never eat a card border — the catalog borders measure gray 108 /
//      silver 181 / pale 156; hard-fail if any side loses more than 4px;
//   5. everything outside the arc ends fully transparent.
async function cleanScan(bytes: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  // semi-transparent halo → fully transparent (interior is fully opaque)
  for (let p = 0; p < w * h; p++) {
    const i = p * ch;
    data[i + 3] = data[i + 3] >= 250 ? 255 : 0;
  }
  // exact content bbox — nothing shaved
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * ch + 3] === 255) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('card scan is fully transparent');
  const bright = (x: number, y: number): boolean => {
    const i = (y * w + x) * ch;
    return (
      data[i + 3] === 255 && Math.min(data[i], data[i + 1], data[i + 2]) > 200
    );
  };
  const rowBright = (y: number): boolean => {
    let br = 0;
    let n = 0;
    for (let x = x0; x <= x1; x += 2) {
      if (data[(y * w + x) * ch + 3] !== 255) continue;
      n++;
      if (bright(x, y)) br++;
    }
    return n > 0 && br / n >= 0.6;
  };
  const colBright = (x: number): boolean => {
    let br = 0;
    let n = 0;
    for (let y = y0; y <= y1; y += 2) {
      if (data[(y * w + x) * ch + 3] !== 255) continue;
      n++;
      if (bright(x, y)) br++;
    }
    return n > 0 && br / n >= 0.6;
  };
  const peel = { t: 0, b: 0, l: 0, r: 0 };
  while (peel.t < 3 && rowBright(y0 + peel.t)) peel.t++;
  while (peel.b < 3 && rowBright(y1 - peel.b)) peel.b++;
  while (peel.l < 3 && colBright(x0 + peel.l)) peel.l++;
  while (peel.r < 3 && colBright(x1 - peel.r)) peel.r++;
  for (const [side, v] of Object.entries(peel)) {
    if (v + 1 > 4) throw new Error(`over-trim on side '${side}': ${v + 1}px`);
  }
  y0 += peel.t + 1;
  y1 -= peel.b + 1;
  x0 += peel.l + 1;
  x1 -= peel.r + 1;
  const cw = x1 - x0 + 1;
  const chh = y1 - y0 + 1;
  // real Pokémon die-cut: 3mm of 63mm = 4.76% of width, circular
  const r = Math.round(cw * 0.0476);
  const mask = Buffer.from(
    `<svg width="${cw}" height="${chh}"><rect width="${cw}" height="${chh}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
  );
  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: x0, top: y0, width: cw, height: chh })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}
```

then inside `composeSlab`, replace the mask/photo block — the WHOLE card sits inside the window at natural aspect (nothing cropped, full die-cut corner curves visible): width-fit with a thin recess inset, resting at the bottom. The leftover pocket above the card is closed with a case-tone GLASSY band + molded lip line — with the uniformly glassy case (Task 2 §2b) the band blends invisibly (pixel-verified: band 115 vs case 117 over a dark page; the earlier v16 band read as "white lighting" only because the case around it was opaque-ringed):

```ts
const cleaned = await cleanScan(photoBytes);
const cMeta = await sharp(cleaned).metadata();
const cw = cMeta.width ?? 0;
const chh = cMeta.height ?? 0;
if (!cw || !chh) throw new Error('card photo has no dimensions');
const inset = Math.max(2, Math.round(winW * 0.0063)); // recess gap (~8px @1600)
const cardW = winW - inset * 2;
const cardH = Math.round((chh * cardW) / cw);
const cardLeft = left + inset;
// TOP-aligned: a real holder grips the card snug under the label rail, with
// the spare recess space at the BOTTOM. Verified against a high-res eBay
// sale photo of the identical PSA-10 slab (docs/research/real-slab-ebay-1.jpg,
// sourced via the card's own PriceCharting sales table): gap label→card
// ≈ 0.07 of slab height, card top ≈ 0.25. A bottom-anchored variant (from
// the low-res 380px PSA cert photo — a misleading reference) was rejected.
const cardTop = top + inset;
const photo = await sharp(cleaned).resize(cardW, cardH).png().toBuffer();
// Glassy SHADOWED-RECESS plate across the WHOLE window, behind the card:
// closes the pocket above the card and makes the thin recess gap + die-cut
// corner cutouts read as the holder's molded interior instead of raw page
// background ("tiny black bars/tips" over a dark page — operator,
// 2026-07-16). Tone 148 renders the recess ~25% darker than the case front
// (pixel targets over a dark page: recess/pocket ~87, case ~115) — matching
// the real slab, where the pocket around the card reads as shadowed
// interior, visibly darker than the case (measured on cert 152108321;
// a case-bright plate made the cut look wrong-sized). The lip line marks
// the recess step just BELOW the card (the spare space sits at the bottom).
// EXCEPTION — the card's four die-cut corner cutouts read as SLAB PLASTIC
// (case tone 197), not shadow (operator, 2026-07-16): even-odd HOLES are
// punched in the shadow rect and filled with case-tone patches. One layer
// per region — stacking two 55%-alpha rects would brighten and de-glass the
// tips (measured 147 vs the 115 target when naively stacked).
// Pixel targets over a dark page: corner tips ~115, gap/pocket ~87, case ~115.
const lipY = inset + cardH + Math.round(fw * 0.0025);
const lipH = Math.max(2, Math.round(fw * 0.003));
const pr = Math.round(cardW * 0.0476) + 6; // die-cut radius + margin
const pcs: Array<[number, number]> = [
  [inset, inset],
  [inset + cardW - pr, inset],
  [inset, inset + cardH - pr],
  [inset + cardW - pr, inset + cardH - pr],
];
const holes = pcs
  .map(([x, y]) => `M${x} ${y}h${pr}v${pr}h-${pr}Z`)
  .join(' ');
const patches = pcs
  .map(
    ([x, y]) =>
      `<rect x="${x}" y="${y}" width="${pr}" height="${pr}" fill="rgb(197,197,201)" fill-opacity="0.55"/>`,
  )
  .join('');
const plate = Buffer.from(
  `<svg width="${winW}" height="${winH}" xmlns="http://www.w3.org/2000/svg">` +
    `<path fill-rule="evenodd" fill="rgb(148,148,153)" fill-opacity="0.55" d="M0 0h${winW}v${winH}h-${winW}Z ${holes}"/>` +
    patches +
    (lipY + lipH < winH
      ? `<rect y="${lipY}" width="${winW}" height="${lipH}" fill="rgb(90,90,95)" fill-opacity="0.5"/>`
      : '') +
    `</svg>`,
);
```

(The `rx`/`ry` mask locals from the old block go away with `CORNER_RX`/`CORNER_RY`; the composite layer uses `cardLeft`/`cardTop` — Step 5.) Existing composeSlab geometry tests: the above-window transparency assertion and the window-CENTRE coverage sample both hold unchanged.

- [ ] **Step 6: Add the rasterised label test (append to `bake-slab.unit.spec.ts`, inside the composeSlab describe)**

```ts
it('renders the label text layer when label fields are passed', async () => {
  const { LABEL_BOX } = await import('../label');
  const out = await composeSlab(await makeFrame(400, 669), await makePhoto(), {
    set: 'Pokemon Surging Sparks',
    name: 'Pikachu ex #238',
    grade: '10',
    year: '2024',
    note: 'SPECIAL ILLUSTRATION RARE',
  });
  const { data, info } = await sharp(out)
    .raw()
    .toBuffer({ resolveWithObject: true });
  // ink somewhere inside the label box band (the frame is transparent here,
  // so any non-zero alpha in the band is label text)
  const y0 = Math.round(669 * LABEL_BOX.top);
  const y1 = Math.round(669 * (LABEL_BOX.top + LABEL_BOX.height));
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] > 0) ink++;
    }
  }
  expect(ink).toBeGreaterThan(100);
});
```

- [ ] **Step 7: Run both suites**

```bash
corepack yarn test:unit src/api/admin/media/__tests__/label.unit.spec.ts src/api/admin/media/__tests__/bake-slab.unit.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/packages/api/src/api/admin/media/label.ts \
        backend/packages/api/src/api/admin/media/bake-slab.ts \
        backend/packages/api/src/api/admin/media/__tests__/label.unit.spec.ts \
        backend/packages/api/src/api/admin/media/__tests__/bake-slab.unit.spec.ts
git commit -m "feat(slab): measured 3-baseline label layout + SVG renderer, composeSlab label layer + real-geometry card fit"
```

---

### Task 6: Data model — `label_year` / `label_note` (§8)

Two nullable operator-editable text columns on Card, staged through from-PriceCharting product metadata (same pattern as `pc_grade`), validated on both card endpoints, and exposed on the admin DTO. No bake changes yet — that's Task 7.

**Files:**

- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260716150000.ts`
- Modify: `backend/packages/api/src/modules/packs/models/card.ts:66` (append two columns)
- Modify: `backend/packages/api/src/api/admin/cards/validate.ts` (+ tests in `__tests__/validate.unit.spec.ts`)
- Modify: `backend/packages/api/src/workflows/steps/create-card.ts` (input type, staging inherit, insert)
- Modify: `backend/packages/api/src/workflows/steps/update-card.ts` (input type, snapshot, patch, compensate)
- Modify: `backend/packages/api/src/workflows/steps/create-product-from-pricecharting.ts:30-46,94-106` (input + metadata staging)
- Modify: `backend/packages/api/src/api/admin/products/from-pricecharting/route.ts` (accept + validate the two fields)
- Modify: `backend/packages/api/src/modules/packs/admin-card.ts` (DTO exposes both fields)

**Interfaces:**

- Consumes: nothing new.
- Produces: `Card.label_year: string | null`, `Card.label_note: string | null`; `RegisterCardInput`/`UpdateCardInput` gain `label_year?: string | null; label_note?: string | null`; `CreateProductFromPcInput` likewise; the admin cards GET returns both fields. Task 7 reads them into the bake; Task 8's forms read/write them.

- [ ] **Step 1: Migration**

Create `Migration20260716150000.ts` (mirrors `Migration20260707130000.ts`):

```ts
import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Card.label_year / label_note — operator-editable graded-slab label fields
// (dynamic-label spec §8). Nullable + blank-by-default: a blank field renders
// nothing on the label, no layout shift.
export class Migration20260716150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "card" add column if not exists "label_year" text null, add column if not exists "label_note" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "card" drop column if exists "label_year", drop column if exists "label_note";`,
    );
  }
}
```

- [ ] **Step 2: Model columns**

In `models/card.ts`, after `pc_synced_at`:

```ts
  // Graded-slab label extras (dynamic-label spec §8) — operator-editable,
  // prefilled from pokemontcg.io on the admin side. label_year is the printed
  // release year ("2024"); label_note is the variety line ("DOUBLE RARE").
  // Changing either re-bakes the composite (update-card re-bakes every save).
  label_year: model.text().nullable(),
  label_note: model.text().nullable(),
```

- [ ] **Step 3: Validation (test-first)**

Append to `backend/packages/api/src/api/admin/cards/__tests__/validate.unit.spec.ts` (match the file's existing style — read it first):

```ts
describe('label fields', () => {
  const base = {
    product_id: 'prod_1',
    market_value: 10,
  };

  it('passes trimmed label_year / label_note through', () => {
    const out = coerceRegisterCardBody({
      ...base,
      label_year: ' 2024 ',
      label_note: 'SPECIAL ILLUSTRATION RARE',
    });
    expect(out.label_year).toBe('2024');
    expect(out.label_note).toBe('SPECIAL ILLUSTRATION RARE');
  });

  it('maps blank/null to null and absent to undefined', () => {
    expect(
      coerceRegisterCardBody({ ...base, label_year: '' }).label_year,
    ).toBeNull();
    expect(
      coerceRegisterCardBody({ ...base, label_year: null }).label_year,
    ).toBeNull();
    expect(coerceRegisterCardBody(base).label_year).toBeUndefined();
  });

  it('rejects non-strings and over-long values', () => {
    expect(() => coerceRegisterCardBody({ ...base, label_note: 42 })).toThrow();
    expect(() =>
      coerceRegisterCardBody({ ...base, label_note: 'x'.repeat(65) }),
    ).toThrow();
  });
});
```

Run: `corepack yarn test:unit src/api/admin/cards/__tests__/validate.unit.spec.ts` — expected FAIL. Then add to `validate.ts`:

```ts
// Graded-slab label extras (dynamic-label spec §8). Same tri-state contract
// as optPcId: undefined = not provided, null/blank = clear, string = value.
const MAX_LABEL_FIELD = 64;
const optLabelField = (
  b: Record<string, unknown>,
  key: string,
): string | null | undefined => {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') bad(`'${key}' must be a string.`);
  const t = (v as string).trim();
  if (t.length > MAX_LABEL_FIELD) {
    bad(`'${key}' is too long (max ${MAX_LABEL_FIELD} chars).`);
  }
  return t === '' ? null : t;
};
```

and add to BOTH return objects (`coerceRegisterCardBody` and `coerceUpdateCardBody`):

```ts
    label_year: optLabelField(b, 'label_year'),
    label_note: optLabelField(b, 'label_note'),
```

Re-run — expected PASS.

- [ ] **Step 4: Workflow inputs + persistence**

`create-card.ts` — extend the input type:

```ts
  // Graded-slab label extras (§8). undefined = inherit the value staged on the
  // product's metadata by /from-pricecharting (like pc_product_id above).
  label_year?: string | null;
  label_note?: string | null;
```

after the `pcGrade` inherit block add:

```ts
const stagedLabel = (k: 'label_year' | 'label_note'): string | null =>
  typeof meta[k] === 'string' && (meta[k] as string).trim() !== ''
    ? (meta[k] as string)
    : null;
const labelYear = input.label_year ?? stagedLabel('label_year');
const labelNote = input.label_note ?? stagedLabel('label_note');
```

and add to the `createCards` insert object:

```ts
          label_year: labelYear,
          label_note: labelNote,
```

NOTE: the `meta` const is currently declared AFTER the bake call — Task 7 moves the bake below it; in this task just declare `labelYear`/`labelNote` after `meta` and persist them.

`update-card.ts` — extend `UpdateCardInput`:

```ts
  // Graded-slab label extras (§8) — same round-trip convention as pc_grade:
  // the edit form loads current values from GET, so omitted → null is safe.
  label_year?: string | null;
  label_note?: string | null;
```

extend `CardSnapshot` with `label_year: string | null; label_note: string | null;`, populate it in the snapshot literal (`label_year: card.label_year ?? null,` etc.), add to the `updateCards` patch (`label_year: input.label_year ?? null,` etc.), and add both to the compensate `updateCards` restore.

- [ ] **Step 5: Staging through from-PriceCharting**

`create-product-from-pricecharting.ts` — add to `CreateProductFromPcInput`:

```ts
  // Graded-slab label extras, staged on product.metadata like pixel_pokemon_id;
  // the create-card step inherits them into Card.label_year / label_note.
  label_year?: string | null;
  label_note?: string | null;
```

and to the `metadata` object in `buildCardProductInput`'s first argument:

```ts
        ...(input.label_year ? { label_year: input.label_year } : {}),
        ...(input.label_note ? { label_note: input.label_note } : {}),
```

`api/admin/products/from-pricecharting/route.ts` — add to `Body`: `label_year?: unknown; label_note?: unknown;`; before the workflow call add:

```ts
const optLabel = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be a string.`,
    );
  }
  const t = value.trim();
  if (t.length > 64) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' is too long (max 64 chars).`,
    );
  }
  return t === '' ? null : t;
};
const label_year = optLabel(body.label_year, 'label_year');
const label_note = optLabel(body.label_note, 'label_note');
```

and pass `label_year, label_note` into the workflow `input`.

- [ ] **Step 6: Admin DTO**

In `backend/packages/api/src/modules/packs/admin-card.ts`, add to the object `toAdminCardDto` returns:

```ts
    label_year: card.label_year ?? null,
    label_note: card.label_note ?? null,
```

(Read the file first and match its exact parameter/property style.)

- [ ] **Step 7: Run migration + tests**

```bash
cd backend/packages/api
corepack yarn medusa db:migrate
corepack yarn test:unit src/api/admin/cards/__tests__/validate.unit.spec.ts
```

Expected: migration applies (`pokenic-postgres` must be up); tests PASS. Verify columns:

```bash
docker exec pokenic-postgres psql -U medusa -d medusa -c "\d card" | grep label_
```

Expected: `label_year | text` and `label_note | text`.

- [ ] **Step 8: Commit**

```bash
git add backend/packages/api/src/modules/packs/migrations/Migration20260716150000.ts \
        backend/packages/api/src/modules/packs/models/card.ts \
        backend/packages/api/src/api/admin/cards/validate.ts \
        backend/packages/api/src/api/admin/cards/__tests__/validate.unit.spec.ts \
        backend/packages/api/src/workflows/steps/create-card.ts \
        backend/packages/api/src/workflows/steps/update-card.ts \
        backend/packages/api/src/workflows/steps/create-product-from-pricecharting.ts \
        backend/packages/api/src/api/admin/products/from-pricecharting/route.ts \
        backend/packages/api/src/modules/packs/admin-card.ts
git commit -m "feat(slab): Card.label_year/label_note — migration, validation, staging, DTO"
```

---### Task 7: Bake plumbing — PSA-only gate + label fields through every caller

`bakeSlabImage` gains the card's label-relevant fields and gates itself on `grader === 'PSA'` (one guard in the shared function — not per caller). The rebake loop additionally CLEARS stale composites on non-PSA graded cards: without that, a CGC card keeps rendering the old PSA "GEM MINT 10" composite forever.

**Files:**

- Modify: `backend/packages/api/src/api/admin/media/bake-slab.ts` (`bakeSlabImage`, `rebakeAllGradedCards`)
- Modify: `backend/packages/api/src/workflows/steps/create-card.ts:111-118` (bake call)
- Modify: `backend/packages/api/src/workflows/steps/update-card.ts:136-148` (bake call)
- Modify: `backend/packages/api/src/scripts/repull-pc-images.ts:138-169` (`rebakeCard`)
- Test: `bake-slab.unit.spec.ts` (append)

**Interfaces:**

- Consumes: `SlabLabelFields`, `composeSlab(frame, photo, label)` (Task 5); `Card.label_year/label_note` (Task 6).
- Produces: `SlabCardInput` and the new `bakeSlabImage` contract:

  ```ts
  export type SlabCardInput = {
    handle: string;
    image: string;
    grader: string;
    grade: string;
    name: string; // may embed "#238"
    set: string;  // PriceCharting console-name
    label_year?: string | null;
    label_note?: string | null;
  };
  bakeSlabImage(container, card: SlabCardInput, frameBytes?): Promise<BakedSlab | null>
  ```

  Callers no longer pre-check the grader — they call unconditionally and write the nulls the existing "bake returned null" path already handles.

- [ ] **Step 1: Write the failing gate test (append to `bake-slab.unit.spec.ts`)**

```ts
// §9 PSA-only bake: the PSA-branded frame must never assert a PSA grade for
// another grader's slab. The gate lives INSIDE bakeSlabImage (one guard for
// every caller) and fires before any container/network use.
describe('bakeSlabImage PSA gate', () => {
  const fields = {
    handle: 'x',
    image: 'https://cdn.example.com/x.webp',
    grade: '10',
    name: 'Pikachu ex #238',
    set: 'Pokemon Surging Sparks',
  };

  it.each([['CGC'], ['BGS'], ['SGC'], [''], ['  ']])(
    'returns null for grader %p without touching the container',
    async (grader) => {
      const { bakeSlabImage } = await import('../bake-slab');
      const container = new Proxy(
        {},
        {
          get() {
            throw new Error('container must not be touched for a non-PSA card');
          },
        },
      );
      await expect(
        bakeSlabImage(
          container as unknown as Parameters<typeof bakeSlabImage>[0],
          { ...fields, grader },
        ),
      ).resolves.toBeNull();
    },
  );
});
```

Run: expected FAIL (type error / gate missing).

- [ ] **Step 2: Implement in `bake-slab.ts`**

Replace `bakeSlabImage`'s signature + head:

```ts
export type SlabCardInput = {
  handle: string;
  image: string;
  grader: string;
  grade: string;
  name: string; // raw card/product name — may embed "#238" (PC convention)
  set: string; // PriceCharting console-name, e.g. "Pokemon Surging Sparks"
  label_year?: string | null;
  label_note?: string | null;
};

// Bake one card. Best-effort by contract: ANY failure logs a warning and
// returns null — a bake must never fail a card save (spec §B.5). PSA-only
// (§9): the frame is PSA-branded, so any other grader (or a raw card) skips
// the bake and renders the bare photo via the existing null path.
export async function bakeSlabImage(
  container: MedusaContainer,
  card: SlabCardInput,
  frameBytes?: Buffer,
): Promise<BakedSlab | null> {
  if (card.grader.trim() !== 'PSA') return null;
  const logger = loggerOf(container);
```

and change the compose call to pass the label:

```ts
const out = await composeSlab(frame, photo, {
  set: card.set,
  name: card.name,
  grade: card.grade,
  year: card.label_year ?? null,
  note: card.label_note ?? null,
});
```

Replace the loop body of `rebakeAllGradedCards` (the `cards` filter stays `grader.trim() !== ''`):

```ts
  for (const card of cards) {
    if (card.grader.trim() !== 'PSA') {
      // §9: non-PSA graders never bake — and a composite left over from the
      // old frame-everything-as-PSA behaviour is a stale GEM MINT 10 lie.
      // Clear it so the card renders its bare photo.
      if (card.slab_image || card.slab_image_key) {
        try {
          const oldKey = card.slab_image_key ?? null;
          await packs.updateCards([
            { id: card.id, slab_image: null, slab_image_key: null },
          ]);
          await mirrorSlabToProduct(container, card.handle, null);
          await deleteSlabFile(container, oldKey);
          logger.info(`bake-slab: cleared non-PSA composite for ${card.handle}`);
        } catch (e) {
          logger.warn(
            `bake-slab: failed to clear non-PSA composite for '${card.handle}': ${e instanceof Error ? e.message : String(e)}`,
          );
          failed++;
          continue;
        }
      }
      ok++;
      continue;
    }
    const baked = await bakeSlabImage(
      container,
      {
        handle: card.handle,
        image: card.image,
        grader: card.grader,
        grade: card.grade,
        name: card.name,
        set: card.set,
        label_year: card.label_year ?? null,
        label_note: card.label_note ?? null,
      },
      frameBytes,
    );
    // ... (the existing persist/cleanup block below is unchanged)
```

- [ ] **Step 3: Update the three callers**

`update-card.ts` (replace the grader-ternary at lines 136-148 — the gate now lives inside the bake):

```ts
// Slab bake (spec §C): re-bake on EVERY save (no dirty-check — one composite
// per admin save is cheap and can never go stale when the photo or label
// fields change); non-PSA grader or grader emptied → null → cleared.
// Best-effort: a failed bake saves with nulls (bare photo).
const baked = await bakeSlabImage(container, {
  handle: input.handle,
  image: input.image,
  grader: input.grader,
  grade: input.grade,
  name: input.name,
  set: input.set,
  label_year: input.label_year ?? null,
  label_note: input.label_note ?? null,
});
```

`create-card.ts` — move the bake call BELOW the `meta`/`stagedLabel` block (Task 6) so the inherited label values exist, and replace it with:

```ts
// Graded PSA card → bake the slab composite BEFORE the insert so the slab
// fields ride the single createCards write and the product-metadata mirror
// below. Non-PSA graders skip inside bakeSlabImage (§9). Best-effort: a
// failed bake registers the card with a bare photo (nulls).
const baked = await bakeSlabImage(container, {
  handle: product.handle,
  image,
  grader: input.grader,
  grade: input.grade,
  name: product.title,
  set: input.set,
  label_year: labelYear,
  label_note: labelNote,
});
```

`repull-pc-images.ts` `rebakeCard` — read the function first; its card row comes from `packs.listCards`, so extend the bake call the same way:

```ts
const baked = await bakeSlabImage(container, {
  handle: card.handle,
  image: newImage,
  grader: card.grader,
  grade: card.grade,
  name: card.name,
  set: card.set,
  label_year: card.label_year ?? null,
  label_note: card.label_note ?? null,
});
```

(Adapt the `image` variable name to what the function actually uses.)

- [ ] **Step 4: Run the full backend unit suite for the touched areas**

```bash
corepack yarn test:unit src/api/admin/media src/api/admin/cards
```

Expected: PASS (including the 33 pre-existing bake-slab tests).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/api/admin/media/bake-slab.ts \
        backend/packages/api/src/api/admin/media/__tests__/bake-slab.unit.spec.ts \
        backend/packages/api/src/workflows/steps/create-card.ts \
        backend/packages/api/src/workflows/steps/update-card.ts \
        backend/packages/api/src/scripts/repull-pc-images.ts
git commit -m "feat(slab): PSA-only bake with per-card label fields; rebake clears stale non-PSA composites"
```

---

### Task 8: Admin UI — grader/grade dropdowns + label year/note fields

§3a is the blocking fix: today grader+grade are derived solely from the PriceCharting tier, so PSA 7/8/9 cannot be entered at all. Add a shared grader select (PSA/BGS/CGC/SGC/none) + fixed 11-point grade select, plus editable Year/Note inputs, on all three card forms.

> **Executor note:** load the `medusa-ui-conformance` skill before writing this task's UI, and follow the existing form patterns in each file.

**Files:**

- Create: `backend/apps/admin/src/components/GraderGradeSelect.tsx`
- Modify: `backend/apps/admin/src/routes/products/from-pricecharting/page.tsx` (replace derived-only grader/grade; add year/note inputs; extend save payload)
- Modify: `backend/apps/admin/src/routes/cards/RegisterCardModal.tsx` (replace the free-text grader/grade Inputs at ~lines 459-476; add year/note; extend POST body)
- Modify: `backend/apps/admin/src/routes/cards/page.tsx` (edit form: FormState, formFromCard, save payload, swap grader/grade Inputs, add year/note)
- Modify: `backend/apps/admin/src/lib/packs-api.ts` and/or `backend/apps/admin/src/lib/admin-rest.ts` (types: `AdminCard`, update/register/from-PC payloads gain `label_year`/`label_note`)
- Modify: the admin i18n resource file (locate with `grep -r "pcAdd.title" backend/apps/admin/src --include=*.json -l`)

**Interfaces:**

- Consumes: backend fields from Task 6 (`label_year`/`label_note` accepted on `/admin/cards`, `/admin/cards/[handle]`, `/admin/products/from-pricecharting`; returned by GET `/admin/cards`).
- Produces: `GraderGradeSelect({ grader, grade, onChange, idPrefix })` used by all three forms; Task 9 prefills the year/note state this task creates on the from-PC page.

- [ ] **Step 1: Shared component**

Create `backend/apps/admin/src/components/GraderGradeSelect.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import { Label, Select } from '@medusajs/ui';

// Client mirror of PSA's canonical 11-point scale (backend source of truth:
// packages/api/src/api/admin/media/label.ts PSA_GRADES — keep in sync).
// Qualifier half-grades (2.5–9.5) deliberately excluded (§3a): the catalog
// doesn't carry them, and 9.5 is a PriceCharting tier, never a PSA grade.
// 1.5 stays — PSA's base FR grade.
export const PSA_GRADES = [
  '10',
  '9',
  '8',
  '7',
  '6',
  '5',
  '4',
  '3',
  '2',
  '1.5',
  '1',
] as const;

const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC'] as const;
const NONE = '__none__'; // @medusajs/ui Select rejects '' as an item value

// Operator asserts the physical slab's grader + grade (PriceCharting only
// supplies the price comp — §3a). Grade is a fixed dropdown so typos and
// impossible grades are unrepresentable.
export function GraderGradeSelect({
  grader,
  grade,
  onChange,
  idPrefix,
}: {
  grader: string;
  grade: string;
  onChange: (v: { grader: string; grade: string }) => void;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-4">
      <div className="flex flex-1 flex-col gap-y-2">
        <Label size="small" weight="plus" htmlFor={`${idPrefix}-grader`}>
          {t('cards.form.grader')}
        </Label>
        <Select
          value={grader === '' ? NONE : grader}
          onValueChange={(v) =>
            onChange({
              grader: v === NONE ? '' : v,
              grade: v === NONE ? '' : grade,
            })
          }
        >
          <Select.Trigger id={`${idPrefix}-grader`}>
            <Select.Value placeholder={t('cards.form.graderNone')} />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value={NONE}>{t('cards.form.graderNone')}</Select.Item>
            {GRADERS.map((g) => (
              <Select.Item key={g} value={g}>
                {g}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>
      <div className="flex flex-1 flex-col gap-y-2">
        <Label size="small" weight="plus" htmlFor={`${idPrefix}-grade`}>
          {t('cards.form.grade')}
        </Label>
        <Select
          value={grade}
          onValueChange={(v) => onChange({ grader, grade: v })}
          disabled={grader === ''}
        >
          <Select.Trigger id={`${idPrefix}-grade`}>
            <Select.Value placeholder="—" />
          </Select.Trigger>
          <Select.Content>
            {PSA_GRADES.map((g) => (
              <Select.Item key={g} value={g}>
                {g}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>
    </div>
  );
}
```

If a card being edited carries a legacy off-scale grade (e.g. `9.5`), render it as an extra disabled-looking `Select.Item` appended when `grade` is non-empty and not in `PSA_GRADES` — the operator can move OFF it but never re-pick it:

```tsx
{
  grade !== '' &&
    !PSA_GRADES.includes(grade as (typeof PSA_GRADES)[number]) && (
      <Select.Item value={grade}>{grade} (legacy)</Select.Item>
    );
}
```

- [ ] **Step 2: From-PriceCharting page**

In `from-pricecharting/page.tsx`:

- Add state: `const [labelYear, setLabelYear] = useState(''); const [labelNote, setLabelNote] = useState('');` (reset both in `runSearch` and `pickMatch` alongside the other resets).
- Change `pickTier` to prefill only when unambiguous (§3a):

```ts
const pickTier = (tierGrade: string, usd: number) => {
  setPcGrade(tierGrade);
  setMarketValue(usd);
  // Prefill ONLY when the tier names a grader ("PSA 10" → PSA/10). Generic
  // "Grade 7/8/9/9.5" tiers are price comps, not PSA claims — the operator
  // states the physical slab's grader + grade themselves (§3a).
  const derived = gradeToGrader(tierGrade);
  setGrader(derived.grader);
  setGrade(derived.grader ? derived.grade : '');
};
```

- Render `<GraderGradeSelect grader={grader} grade={grade} onChange={(v) => { setGrader(v.grader); setGrade(v.grade); }} idPrefix="pc" />` in the Step-2 section (replacing the passive `pcAdd.grade.derivedHint` text), plus two `Input`s for `labelYear`/`labelNote` with labels `t('cards.form.labelYear')` / `t('cards.form.labelNote')` and hint `t('cards.form.labelHint')`.
- Extend `canSave` with grader/grade pairing: `(grader === '' || grade !== '') &&`.
- Extend the `createProduct.mutateAsync` payload: `label_year: labelYear.trim() || null, label_note: labelNote.trim() || null,` and add both fields to the corresponding request type in `lib/queries.ts`/`admin-rest.ts`.

- [ ] **Step 3: RegisterCardModal + card edit form**

`RegisterCardModal.tsx`: add `label_year`/`label_note` to the form-state type (init `''`; when the product carries staged metadata the backend inherits, so blank here is fine), replace the two free-text grader/grade `Input`s (~lines 459-476) with `<GraderGradeSelect ... idPrefix="register" />`, keep the `applyPrice` prefill but mirror the pickTier semantics (only set grade when a grader was derived), add the two label `Input`s, and include `label_year: fields.label_year.trim() || null, label_note: fields.label_note.trim() || null` in the submit body.

`cards/page.tsx`: add `label_year: string; label_note: string;` to `FormState`; in `formFromCard`: `label_year: c.label_year ?? '', label_note: c.label_note ?? '',`; add both to the save payload (`label_year: form.label_year.trim() || null,` etc.); swap the edit form's grader/grade `Input`s for `<GraderGradeSelect ... idPrefix="edit" />`; add the two label `Input`s beside them. Also add `label_year: string | null; label_note: string | null;` to the `AdminCard` type in `lib/packs-api.ts` and to the update-payload type.

- [ ] **Step 4: i18n keys**

Locate the translation resource (`grep -r "pcAdd.title" backend/apps/admin/src -l`) and add, following its structure:

```json
"cards": {
  "form": {
    "graderNone": "None (raw)",
    "labelYear": "Label year",
    "labelNote": "Label note",
    "labelHint": "Printed on the slab label. Blank renders nothing."
  }
}
```

(`cards.form.grader` / `cards.form.grade` already exist.)

- [ ] **Step 5: Build + manual check**

```bash
cd backend/apps/admin
corepack yarn build
```

Expected: clean build. Then with the stack up (backend :9000, admin :7000), open Add-from-PriceCharting: pick a product, pick the `Grade 9` tier → grader select shows None and grade is empty; choose PSA + 9; the grade dropdown offers exactly `10 9 8 7 6 5 4 3 2 1.5 1`. Open a card in Gacha Cards → grader/grade render as selects, Year/Note fields round-trip a save.

- [ ] **Step 6: Commit**

```bash
git add backend/apps/admin/src/components/GraderGradeSelect.tsx \
        backend/apps/admin/src/routes/products/from-pricecharting/page.tsx \
        backend/apps/admin/src/routes/cards/RegisterCardModal.tsx \
        backend/apps/admin/src/routes/cards/page.tsx \
        backend/apps/admin/src/lib/packs-api.ts backend/apps/admin/src/lib/admin-rest.ts \
        backend/apps/admin/src/lib/queries.ts <i18n file>
git commit -m "feat(admin): operator-chosen grader + 11-point grade selects, label year/note fields"
```

---

### Task 9: pokemontcg.io prefill for year + note (§7a)

A small admin-authed proxy that resolves a PriceCharting console-name + card number to `{ year, note }` via pokemontcg.io (EN only — JP has zero coverage and stays operator-entered). Cached in memory (set data is immutable once released), 5s timeout, degrades to nulls. **This prefills the admin form only — it is NOT in the bake path.**

**Files:**

- Create: `backend/packages/api/src/api/admin/tcg/tcg-meta.ts`
- Create: `backend/packages/api/src/api/admin/tcg/card-meta/route.ts`
- Test: `backend/packages/api/src/api/admin/tcg/__tests__/tcg-meta.unit.spec.ts`
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (fetch helper), `backend/apps/admin/src/routes/products/from-pricecharting/page.tsx` (prefill effect)

**Interfaces:**

- Consumes: `parseCardName` (Task 3) on the admin side is NOT needed — the page derives the number with the same regex inline (see Step 4).
- Produces: `GET /admin/tcg/card-meta?set=<pc console-name>&number=<238>` → `{ year: string | null, note: string | null }`.

- [ ] **Step 1: Failing tests**

Create `__tests__/tcg-meta.unit.spec.ts`:

```ts
import { pcSetToTcgName, fetchTcgCardMeta } from '../tcg-meta';

describe('pcSetToTcgName', () => {
  it('strips the Pokemon prefix', () => {
    expect(pcSetToTcgName('Pokemon Surging Sparks')).toBe('Surging Sparks');
  });
  it('routes Japanese sets to null — pokemontcg.io has zero JP coverage (§7a)', () => {
    expect(pcSetToTcgName('Pokemon Japanese Mega Dream ex')).toBeNull();
  });
  it('returns null for blank input', () => {
    expect(pcSetToTcgName('  ')).toBeNull();
  });
});

describe('fetchTcgCardMeta', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  const setResp = {
    data: [{ id: 'sv8', name: 'Surging Sparks', releaseDate: '2024/11/08' }],
  };
  const cardResp = { data: [{ rarity: 'Special Illustration Rare' }] };

  it('resolves year from the set and UPPERCASED rarity from the card', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(setResp), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cardResp), { status: 200 }),
      );
    expect(await fetchTcgCardMeta('Pokemon Surging Sparks', '#238')).toEqual({
      year: '2024',
      note: 'SPECIAL ILLUSTRATION RARE',
    });
  });

  it('degrades to nulls on any upstream failure (§7a — never blocks manual entry)', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await fetchTcgCardMeta('Pokemon Lost Origin Zzz', '#1')).toEqual({
      year: null,
      note: null,
    });
  });

  it('serves a repeat set lookup from cache', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(setResp), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cardResp), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cardResp), { status: 200 }),
      );
    await fetchTcgCardMeta('Pokemon Surging Sparks', '#238');
    await fetchTcgCardMeta('Pokemon Surging Sparks', '#239');
    // 3 calls total: set once (cached on the 2nd card), card twice
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns nulls for a Japanese set without any network call', async () => {
    expect(
      await fetchTcgCardMeta('Pokemon Japanese Mega Dream ex', '#240'),
    ).toEqual({
      year: null,
      note: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

Run — expected FAIL (module missing). Note: because the module caches, use DISTINCT set names per test (as above) or `jest.isolateModulesAsync`.

- [ ] **Step 2: Implement `tcg-meta.ts`**

```ts
// pokemontcg.io lookup for graded-slab label prefill (spec §7a): a release
// year is an objective fact and PSA's Variety is usually the rarity, so both
// prefill the admin form — but stay operator-overridable, and this NEVER
// feeds the bake path directly. EN only: pokemontcg.io has zero Japanese
// coverage. Set data is immutable once released → cache success forever;
// failures are NOT cached so a transient outage degrades to manual entry,
// not a permanently-empty prefill.
const TCG_API = 'https://api.pokemontcg.io/v2';
const TIMEOUT_MS = 5_000;

export type TcgCardMeta = { year: string | null; note: string | null };

export function pcSetToTcgName(consoleName: string): string | null {
  const stripped = consoleName.trim().replace(/^Pokemon\s+/i, '');
  if (stripped === '' || /^Japanese\b/i.test(stripped)) return null;
  return stripped;
}

type TcgSet = { id: string; name: string; releaseDate?: string };

const setCache = new Map<string, TcgSet>();
const cardCache = new Map<string, string | null>(); // set.id:number → rarity

const getJson = async (url: string): Promise<unknown | null> => {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return null;
    return (await resp.json()) as unknown;
  } catch {
    return null;
  }
};

export async function fetchTcgCardMeta(
  consoleName: string,
  number: string,
): Promise<TcgCardMeta> {
  const none: TcgCardMeta = { year: null, note: null };
  const setName = pcSetToTcgName(consoleName);
  if (!setName) return none;

  const setKey = setName.toLowerCase();
  let set = setCache.get(setKey) ?? null;
  if (!set) {
    // Mechanical match, not fuzzy (§7a): exact name equality after the prefix
    // strip; a miss means "unknown set", never a guess.
    const json = await getJson(
      `${TCG_API}/sets?q=${encodeURIComponent(`name:"${setName}"`)}`,
    );
    const sets = (json as { data?: TcgSet[] } | null)?.data;
    if (!sets) return none; // upstream failure — do not cache
    set = sets.find((s) => s.name.toLowerCase() === setKey) ?? null;
    if (set) setCache.set(setKey, set);
  }
  if (!set) return none;

  const year = set.releaseDate ? set.releaseDate.slice(0, 4) : null;
  const num = number.replace(/^#/, '').trim();
  if (!num) return { year, note: null };

  const cardKey = `${set.id}:${num.toLowerCase()}`;
  if (!cardCache.has(cardKey)) {
    // Scoping by set id is required — a bare name+number query can collide
    // across sets (§7a).
    const json = await getJson(
      `${TCG_API}/cards?q=${encodeURIComponent(`set.id:${set.id} number:${num}`)}`,
    );
    const cards = (json as { data?: Array<{ rarity?: string }> } | null)?.data;
    if (!cards) return { year, note: null }; // upstream failure — do not cache
    cardCache.set(cardKey, cards[0]?.rarity ?? null);
  }
  const rarity = cardCache.get(cardKey) ?? null;
  return { year, note: rarity ? rarity.toUpperCase() : null };
}
```

Create `card-meta/route.ts`:

```ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { fetchTcgCardMeta } from '../tcg-meta';

// GET /admin/tcg/card-meta?set=<pc console-name>&number=<238> — label-prefill
// lookup (spec §7a). Admin-authed by path. Always 200 with nullable fields:
// a lookup miss/outage means "operator types it", never an error state.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const set = typeof req.query.set === 'string' ? req.query.set : '';
  const number = typeof req.query.number === 'string' ? req.query.number : '';
  if (set.trim() === '') {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "'set' is required.");
  }
  res.json(await fetchTcgCardMeta(set, number));
}
```

Run the tests — expected PASS.

- [ ] **Step 3: Admin fetch helper**

In `backend/apps/admin/src/lib/admin-rest.ts`, following the file's existing request pattern, add:

```ts
export type TcgCardMeta = { year: string | null; note: string | null };

export const getTcgCardMeta = (set: string, number: string) =>
  request<TcgCardMeta>(
    `/admin/tcg/card-meta?set=${encodeURIComponent(set)}&number=${encodeURIComponent(number)}`,
  );
```

(Match the actual helper name/shape used by `searchPriceCharting` in that file.)

- [ ] **Step 4: Prefill on the from-PC page**

In `from-pricecharting/page.tsx`, inside `pickMatch` after `setPcProduct(product)` succeeds:

```ts
// §7a prefill: year (set release) + note (rarity) from pokemontcg.io.
// Fill-only — the fields stay editable and a lookup failure just leaves
// them blank for the operator. The card number rides product-name
// ("Pikachu ex #238" — PC has no separate field).
const num = product.name.match(/#\s*([A-Za-z0-9/-]+)\s*$/)?.[1] ?? '';
void getTcgCardMeta(product.set, num)
  .then((meta) => {
    setLabelYear((v) => v || meta.year || '');
    setLabelNote((v) => v || meta.note || '');
  })
  .catch(() => {});
```

- [ ] **Step 5: Build + verify**

```bash
cd backend/packages/api && corepack yarn test:unit src/api/admin/tcg/__tests__/tcg-meta.unit.spec.ts
cd ../../apps/admin && corepack yarn build
```

Expected: PASS + clean build. With the stack up, pick `Pokemon Surging Sparks · Pikachu ex #238` on the from-PC page → Year prefills `2024`, Note prefills `SPECIAL ILLUSTRATION RARE`; pick a Japanese product → both stay blank.

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/api/admin/tcg \
        backend/apps/admin/src/lib/admin-rest.ts \
        backend/apps/admin/src/routes/products/from-pricecharting/page.tsx
git commit -m "feat(admin): pokemontcg.io year/rarity prefill for slab label fields"
```

---

### Task 10: Rollout — rebake, end-to-end verification, PR (§12)

**Files:** none new (operational).

**Interfaces:**

- Consumes: everything above; local stack (`pokenic-postgres` up, backend `corepack yarn dev` from `backend/packages/api`).

- [ ] **Step 1: Full check gates**

```bash
cd backend/packages/api && corepack yarn test:unit src
cd ../../.. && npm run check
```

Expected: all backend unit tests pass; root lint + typecheck + build green. (If `next build` crashes immediately with "Cannot read properties of undefined (reading 'length')", stop any serve-standalone server and `rm -rf .next` first — stale-cache trap.)

- [ ] **Step 2: Rebake every graded card**

Backend must be running (it serves the localhost card images the SSRF fix un-blocks):

```bash
cd backend/packages/api
corepack yarn medusa exec ./src/scripts/bake-slab-images.ts
```

Expected: `ok` count = number of PSA cards (3 in the current catalog), `failed: 0`, plus `cleared non-PSA composite` lines for any non-PSA graded cards.

- [ ] **Step 3: Verify the composites carry the REAL grade**

```bash
docker exec pokenic-postgres psql -U medusa -d medusa -c "select handle, grader, grade, label_year, label_note, slab_image from card where grader <> '';"
```

Download each `slab_image` URL and Read the images: the label must show the card's own grade + descriptor (a PSA 9 shows `MINT 9`, never `GEM MT 10`), the mapped set line, name with suffix casing intact, and the year/note when set. This is the bug the feature exists to fix — check every card, not one.

- [ ] **Step 4: Storefront visual check at the new aspect**

```bash
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4000   # run in background
```

Screenshot the marketplace/slots pages with an existing `scripts/qa-*.mjs`-style Playwright script into `docs/research/` and Read the PNGs: slabs render un-stretched (frame and `SLAB_ASPECT` now agree — §5), raw cards still letterbox correctly.

- [ ] **Step 5: Refresh the code index**

Run `detect_changes` on the codebase-memory MCP (or `index_repository` if drift is large) so the graph reflects the new modules.

- [ ] **Step 6: PR**

```bash
git log @{u}..HEAD --oneline   # public repo: verify EVERY commit is yours (epitaxy trap)
git status --short             # slot-sfx files must still be unstaged/uncommitted
git push -u origin feat/graded-slab-dynamic-label
gh pr create --title "feat: graded-slab dynamic PSA label (real grade per card)" --body "..."
```

PR body: summarize the live bug fixed (every slab baked as GEM MINT 10), the PSA-only decision, the SSRF `localFileOrigin` seam, and the trade-dress note from §13 (operator-acknowledged). Then run `/code-review`, and `/security-review` for the SSRF-adjacent change (both advisory gates from `.claude/rules/common/agents.md`).

---

## Self-review notes (already applied)

- **Spec coverage:** §1–§3a → Tasks 7/8; §4–§5 → Task 2; §6 → Task 5; §7 → Task 4; §7a → Tasks 6/9; §8 → Tasks 3/6; §9 → Task 7; §10 → Tasks 5/7 (shrink/ellipsize, never-fail contract untouched); §11 → test steps in Tasks 3/5/7 (grade-picker exactness tested in Task 3 via `PSA_GRADES`); §12 → Task 10; §13 → holo probe in Task 2 + trade-dress note in the PR body.
- **Known deferrals:** BGS/CGC/SGC grade scales are not modeled (only PSA bakes; the shared 11-point list is a UI convenience — noted in Task 8). Backend does not hard-reject off-scale grades (legacy 9.5 rows must stay saveable; `psaDescriptor` renders them safely).
- **Type consistency:** `SlabLabelFields` (set/name/grade/year/note) is produced in Task 5 and consumed verbatim by `composeSlab`; `SlabCardInput` (Task 7) adds handle/image/grader + label columns; `PSA_GRADES` exists once in backend `label.ts` with a commented client mirror in `GraderGradeSelect.tsx`.
