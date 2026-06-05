---
name: claw-rebrand
description: Rebrand the animated claw-machine assets (public/images/claw/*-anim.avif + *-machine.webp) from one wordmark to another — the top banner wordmark, the lower placard "<brand> claw.", and the base url "<brand>.com". Use this WHENEVER the user wants to re-brand, re-skin, or change the name on the claw machines, fix/move/resize the placard or url text baked into a machine, re-bake the claw animations, or says the claw text is "outside the machine", "doubled", "blurry", "wrong position", or "still says <old-brand>". Also triggers on "rebrand the claw", "change phygitals to X on the machines", "the claw machine text is off". Tied to this repo's measurement-driven pipeline (scripts/rebrand_bottom.mjs, rebake_ff.mjs, etc.); follow it instead of hand-editing pixels.
argument-hint: "<old-brand> <new-brand>  (e.g. phygitals pokenic)"
user-invocable: true
---

# Claw-Machine Rebrand

Rebrand the claw machines on `/claw/[slug]` from one brand to another. Each machine ships as a
**self-contained animated AVIF** (`public/images/claw/<base>-anim.avif`) plus a static `<base>-machine.webp`
fallback. The brand appears in three baked zones: the **banner wordmark** (top), the **placard** (lower-left,
two lines: `<brand>` / `claw.`), and the **base url** (`<brand>.com`). This skill rebakes those zones.

This is a **measurement-driven, verify-at-every-stage** pipeline. The expensive failures here all came from
*eyeballing* and *not self-verifying* — so the discipline below is the actual product, not ceremony.

## The mental model

- The live `<img>` (`PackDetailClient.tsx`) shows `claw.anim ?? claw.webp` — one animated AVIF, the claw
  sliding L↔R *inside* the file. There is no DOM/sprite/Lottie layer; the brand is **baked into pixels**.
- An AVIF carries a **1-frame "still" stream PLUS the animated sequence** (often 71–142 frames). Always
  operate on the multi-frame stream.
- The banner + placard + url are **static across frames** ("static zones"). The pipeline rebrands them once
  on the still image, freezes them into an RGBA **patch**, and **overlays that patch onto every frame**, then
  re-encodes. The moving claw shows through the patch's transparent area.

## Tooling (this machine)

- **Pillow/numpy + AVIF**: `C:/Users/PC/iopaint-venv/Scripts/python.exe` (has `pillow_avif`). Use it for all
  Python here — it decodes AVIF + animated WebP and is trusted for frame counts.
- **ffmpeg** (gyan.dev full build): `libsvtav1` encoder, `overlay` filter, `ffprobe`. It **cannot decode our
  animated WebP sources** — those go through the Pillow frame-extract bridge.
- Verify against the **production** server, never `next dev` (dev serves these images slowly and makes a
  correct build look broken). Screenshot with **Playwright scripts**, not Chrome/preview MCP.

## The scripts (the pipeline)

| Script | Role |
|---|---|
| `scripts/measure_placard.py` | Orig-vs-current side-by-side crops of the placard zone with a fractional grid — read the **true** original text left/top. |
| `scripts/detect_placard_bbox.py` | Label-constrained, widest-run text-bbox detector; draws the box back on a fine grid so you **verify by eye**, not by a raw number. |
| `scripts/rebrand_bottom.mjs` | Playwright canvas: erase the baked old placard/url and bake the new ones. Per-machine `OVERRIDES` (pins/bands). Emits coords JSON. |
| `scripts/make_patch.py` | Build the RGBA overlay patch: static zones (banner band + placard/url edit-mask) opaque, everything else transparent. |
| `scripts/extract_frames.py` | Pillow bridge — decode an animated-WebP source to a PNG sequence for ffmpeg. |
| `scripts/rebake_ff.mjs` | ffmpeg overlay+encode: composite the patch onto every frame → new animated AVIF. |
| `scripts/shot-stage.mjs` / `verify-claw-placard*.mjs` | Live prod-server screenshots for final verification. |

## Workflow

Work a small set of machines at a time. Bases group into three detection regimes:
- **pokemon** (mythic/legend/elite/platinum/rookie/trainer): clean labels → auto-**detection** works.
- **base-group** (nba `legend-pack-1dpaec`/`modern-grails-noafw0`, `starter-riftbound-pack`): busy backgrounds
  wreck detection → **PINNED** in `OVERRIDES`.
- **soccer** (`pro-soccer-pack`): uses a **band** override.

### 1. Measure the original text position — do NOT eyeball
For pinned machines, restore the pristine original still (the one with the *old* brand still baked) and
measure where its placard text actually sits:
```bash
# restore pristine originals (the commit/source that still has the OLD brand baked)
for b in <base...>; do git checkout <pristine-ref> -- "public/images/claw/$b-machine.webp"; done
C:/Users/PC/iopaint-venv/Scripts/python.exe scripts/detect_placard_bbox.py orig <base...>
```
Then **read the `bbox_orig_<base>.png` images** — confirm the green box sits on the "p" of the old wordmark
and read its left/top off the fine grid. The detector is contaminated by busy backgrounds (basketball
shadows, box seams, kraft labels); the **drawn box + grid is ground truth**, the raw number is not.

### 2. Set pins / bands in `OVERRIDES` (rebrand_bottom.mjs)
`pin.x` = the measured **original left edge**. `pin.y` = measured top. `pin.w` = erase width — **cap it at the
label's right edge** (measure label vs text right edge; e.g. text ends 0.452, label ends 0.473 → pick ~0.46).
Overshooting `w` onto the gold box / dark frame is what paints the white/tan **tab** artifact.

### 3. Rebrand the stills
```bash
for b in <base...>; do git checkout <pristine-ref> -- "public/images/claw/$b-machine.webp"; done
node scripts/rebrand_bottom.mjs <base...>
```
Always restore pristine first so the erase targets the *original* text, not a previous rebrand attempt.

### 4. Verify the stills (BEFORE baking)
Regenerate the comparison + tab-region crops and **look**:
```bash
C:/Users/PC/iopaint-venv/Scripts/python.exe scripts/measure_placard.py <base...>
C:/Users/PC/iopaint-venv/Scripts/python.exe scripts/detect_placard_bbox.py cur <base...>
```
Confirm for each: new wordmark sits exactly where the old one was (aligned with any preserved sub-label),
**no doubled line**, **no blur**, **no tab** on the box beside the label, and the url reads `<new>.com` with no
`<old>` residue. Only proceed when all stills are clean — shipping unverified is what caused the repeat rounds.

### 5. Re-bake the animations
```bash
# kill any stale rebake/ffmpeg first (avoid duplicate-hang), then:
node scripts/rebake_ff.mjs <base...>
```
`rebake_ff.mjs` runs `make_patch.py` then, per base: AVIF sources feed ffmpeg directly (overlay onto the
multi-frame stream); animated-WebP sources go through `extract_frames.py` → PNG seq → ffmpeg.

### 6. Verify the anims
```bash
C:/Users/PC/iopaint-venv/Scripts/python.exe -c "import pillow_avif; from PIL import Image; import glob,os; [print(os.path.basename(f), Image.open(f).n_frames,'f') for f in sorted(glob.glob('public/images/claw/*-anim.avif'))]"
```
Frame counts must be full (tens–140s, never 1 or 25). Extract `frame 0` of each re-baked anim and confirm the
placard is correct **in the animation**, not just the still.

### 7. Cache-bust, build, serve, verify live
- Bump `CLAW_REV` in `src/app/claw/packs-data.ts` (filenames are stable; the `?v=` query busts caches).
- `npm run build`
- Free port 4000, then start prod **directly** (npx wrapper proved flaky): `node node_modules/next/dist/bin/next start -p 4000`
- `node scripts/verify-claw-placard.mjs` / `verify-claw-placard-zoom.mjs` → read the `live_*`/`livezoom_*` PNGs.

If you add/remove an animated source, update `CLAW_HAS_ANIM` in `packs-data.ts` (only bases in that set serve
the `-anim.avif`; others fall back to the static webp).

## Critical lessons (why each step is shaped this way)

1. **Measure, don't eyeball.** `rebrand_bottom.mjs` draws with `textAlign:"left"; fillText(text, pin.x*W, …)`
   — the rendered left edge **equals the pin**, no hidden offset. The pokemon machines (same draw path) prove
   it. So `pin.x = measured original left edge`, full stop. Eyeballed pins landed ~0.03 left, twice.
2. **Cap the erase at the label edge.** The pin's `blockRight = (pin.x + w)*W`. If that reaches past the white/
   kraft label onto the gold box or dark frame, the box's dark shading passes the stroke threshold, gets
   masked, and is filled white/tan from the nearest label pixel → a visible **tab**. Keep `blockRight ≤ label
   right edge`.
3. **Detection is contaminated by busy backgrounds.** Constrain to the bright label, take the **widest
   contiguous run** of text columns (rejects thin seams), and **verify by drawing the bbox back** on a grid.
   Never trust a raw detected number near a basketball/seam/edge.
4. **ffmpeg: `-frames:v <N>`, never `-shortest`.** With `-loop 1 -i patch` the patch is an *infinite* stream;
   `-shortest` intermittently fails to terminate the overlay and ffmpeg pegs every core **forever** (we hit a
   23,500s-CPU runaway). Cap output frames explicitly and add `execFileSync` `timeout` backstops.
5. **AVIF = still + animated stream.** Pick the multi-frame video stream (most frames). Parse `ffprobe -of
   json` **by field name** — its CSV column order is *not* the requested order (a positional parser read
   `avg_frame_rate "25/1"` as `nb_frames` → truncated 25-frame output).
6. **Verify at every stage** — stills → anim `frame 0` → live prod server. The repeated user complaints were
   all "shipped without self-verifying." A passing earlier stage is not proof of the next.
7. **Cache-bust with `CLAW_REV`.** Pixels change but filenames don't; without the bump browsers serve stale.
8. **Prod server only.** `npm run build` + `node node_modules/next/dist/bin/next start -p 4000`, screenshot via
   Playwright. `next dev` and Chrome/preview MCP gave hours of false "still broken."
9. **Watch for runaway node/ffmpeg.** Before any re-bake, kill stale `rebake_ff`/`ffmpeg` (a duplicate caused a
   hang). Check counts; `Get-Process ffmpeg | Stop-Process -Force`. Don't leave orphan `next start` on :4000.
10. **Frame-fit.** The machine renders are all **1.44 (36/25)**. The claw stage in `PackDetailClient.tsx` must
    use `aspect-[36/25]` (not a wider `16/10`) with the img at `h-full w-full object-contain`, or the machine
    letterboxes inside its frame instead of filling it.

## Output artifacts
Rebranded `public/images/claw/<base>-anim.avif` (+ `-machine.webp`), updated `CLAW_REV`, and verification PNGs
under `docs/research/packdetail/` (`measure_*`, `bbox_*`, `tabcheck_*`, `animframe_*`, `live*_*`). Commit the
assets + `packs-data.ts` bump together.
