# Workflows

End-to-end recipes for this repo. Run from repo root so the root `.env` (key) is found. Save drafts to `docs/research/`, ship final assets to `public/images/`.

## 1. Reference-led variant generation (the correct pattern)

The thing that went wrong repeatedly: generating from text when a reference existed. Do this instead.

```bash
# a. If the user pasted the image into chat, save it first
powershell -STA -NoProfile -File .claude/skills/snapgen-generate/scripts/save-clip.ps1 docs/research/ref.png

# b. Attach it; prompt only the DELTA, keep it short (see prompt-engineering.md)
node .claude/skills/snapgen-generate/scripts/snapgen.mjs image \
  "same protector style as the reference, empty window, no card inside" \
  --files docs/research/ref.png --model nano-banana-2 \
  --aspect_ratio 9:16 --resolution 1K --output_format png \
  --out docs/research

# c. Rename to something meaningful (downloads land as snapgen-<uuid8>-<i>.png)
mv docs/research/snapgen-*-0.png docs/research/sleeve-v1-gold.png
```

Always pass `--out docs/research` (or the final destination) — never let `snapgen-*.png` land in the repo root.

For a set of variants, change only the delta phrase per run and generate **one at a time** (`snapgen-one-at-a-time` memory) — never a parallel batch. Draft at `1K` (~3 credits); re-render only the winner at high res.

## 2. Chroma-key overlay pipeline (frame that sits OVER other art)

**Shortcut for generic transparent assets:** `snapgen.mjs image "…" --transparent` does this whole loop in one command — injects the magenta background, forces png, keys the download to a subject-trimmed `<file>-alpha.png` (run from repo root so `sharp` resolves, or set `SHARP_PATH`). Use the manual pipeline below when you need the slab-specific geometry (window insets) that `process-slab-frame.mjs` computes.

For a frame/protector/sleeve that overlays a card or slab, generate it with a **flat magenta** window + background, then key the magenta transparent with the existing repo script.

```bash
# a. Generate with the window AND background as FLAT SOLID MAGENTA #FF00FF
#    (this is the one place a structural negative/hex is justified)
node .claude/skills/snapgen-generate/scripts/snapgen.mjs image \
  "gold glitter holographic slab sleeve, single rectangular window, \
   window and background flat solid magenta #FF00FF" \
  --model nano-banana-2 --aspect_ratio 9:16 --resolution 2K

# b. Key magenta -> transparent (min(R,B)-G test; keeps opaque art byte-identical)
node scripts/process-slab-frame.mjs docs/research/sleeve-final.png
#    -> writes public/images/slab-frame.webp (+ a preview PNG in docs/research/)
#    SHARP_PATH=<dir> if backend node_modules is absent (fresh worktree)
```

Layering reminder: card photo → baked slab (`card.slab_image`, `SLAB_ASPECT` = 1462/2446) → the sleeve is the **outermost** ring, window sized to the SLAB's outer edge, not the card.

## 2b. Overlay that must fit a fixed target (slab) — build it, don't generate the fit

**Hard-won (2026-07-16):** no model aspect enum equals the slab's 0.598, so a generated frame's window never hugs the slab natively — generating at 2:3/9:16 then squeezing to fit distorts the ring and wastes credits/iterations. Generate only the **look**, then **construct** the frame to the measured slab.

1. **Measure the target.** Bake the reference slab with the exact backend logic — port `composeSlab()` from `bake-slab.ts` (constants: `SLAB_WINDOW {top .2833, left/right .1047, bottom .0666}`, corner `rx .048`/`ry .034`), or pull a `card.slab_image`. `sharp(baked).trim()` → the slab's true pixel size and aspect.
2. **Generate the texture only**, on flat magenta (any convenient aspect — it's just a swatch).
3. **Wrap a uniform ring to the measured slab:**
   - key the texture's magenta, `.trim()` so the holo touches all 4 edges (else the ring samples background);
   - build an SVG alpha mask = outer rounded-rect **minus** the slab window (inset by a few px so the ring laps the slab edge);
   - `resize` the keyed holo to the outer size, `dest-in` the ring mask;
   - composite `slab` then `ring` on the stage.
     Border thickness (`≈3.3% of slab width`) and overlap become **parameters you control**, and the window equals the slab **by construction** — fits every card automatically, no per-card tuning, no re-rolls.

Worked script: this session's `bake-final.mjs` (scratchpad). The same construction is how the shipped overlay should be produced.

## 3. Crop a mockup to a tight asset

When the model renders the object with a margin/background (e.g. a card mockup on a desk), crop to the object edges with `sharp`. Measure edges by brightness profile, extract, resize to the target box, emit webp. For rounded objects, either crop **inside** the corner arcs (opaque, no alpha — safest against background bleed) or alpha-mask the corners with a matching rounded-rect. See the card-back crop in this repo's history for a worked example (opaque inset crop avoided purple corner tips from the stage showing through alpha).

## 4. Video generation + resume

```bash
# Submit and wait (up to 15 min)
node .claude/skills/snapgen-generate/scripts/snapgen.mjs video seedance \
  "slow push in on the slab, holo shimmer" --model seedance-2 \
  --ref_images docs/research/slab.png --duration 5 --resolution 720p

# For long jobs: fire and rejoin
node .../snapgen.mjs video kling "..." --model kling-video-3-0 --duration 10 --no-wait
node .../snapgen.mjs wait <uuid>      # rejoin
node .../snapgen.mjs status <uuid>    # or inspect raw JSON
```

Local video/audio refs upload via `--ref_videos`/`--ref_audios` (seedance-2-omni, kling motion/edit models only — see `media-inputs.md`). To continue a finished clip: `extend seedance "keep pushing in" --ref_history <uuid>`.

## 5. Housekeeping

```bash
node .../snapgen.mjs account                 # plan + credits (check before a big run)
node .../snapgen.mjs history --filter_by image
node .../snapgen.mjs <cmd> ... --dry-run     # validate params, spend nothing
```

Result URLs expire ~30 days; the script downloads by default. Keep masters locally in `docs/research/` (drafts) or `public/images/` (shipped).

## Maintainer note

Extends (`extend <veo|grok|seedance|kling>`) and Grok storyboard (`storyboard`) are wrapped as of 2026-07-17. Still unwrapped (verified against the docs `openapi.json`): `GET video-gen/veo/voice` (voice list for omni-flash `--voice_media_id`), `POST uapi/v2/imagen/grok` (v2, `ref_images`-based), and the history-delete endpoints. TTS/speech/dialogue have **no public API endpoints** despite the docs intro. Webhooks exist (push callbacks, HMAC-signed) but need a public URL — polling is right for local CLI use. To add an endpoint:

1. Confirm the endpoint + fields at https://docs.snapgen.ai.
2. Small addition → new entry in `VIDEO_PATHS` (or a new `case`) in `scripts/snapgen.mjs`; one-off need → plain `curl` with `x-api-key` per the docs.
3. If a new field carries a **local file**, it must be handled like `files`/`ref_images` in `buildForm` (blob upload) — otherwise it silently sends the path string.
4. Add a `--dry-run` assertion for it in `scripts/test.mjs`, run the self-check, and document it in `SKILL.md` + the relevant reference file.
