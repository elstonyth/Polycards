---
name: snapgen-generate
description: |
  Use when generating images or videos via the SnapGen (GeminiGen) API —
  "generate with snapgen", "use snapgen", cheap API image/video generation,
  Nano Banana / GPT Image 2 / Grok / Meta AI / Veo / Sora / Seedance / Kling via API,
  checking SnapGen credits, or polling a SnapGen job. Also use when Higgsfield
  is unavailable (no credits / API excluded) and the user wants the API
  alternative. Product photoshoots, marketplace listing cards, ad/UGC
  creatives, and character-consistent sets are handled HERE via
  references/playbooks.md — skill-side prompt templates on the same base
  models Higgsfield's enhancers use. NOT for: 3D/GLB, music/SFX/TTS, video
  analysis, or website building — the SnapGen API has no endpoints for those
  modalities.
argument-hint: '[image|gpt-image|video <family>|extend <family>|account] [prompt]'
allowed-tools: Bash
---

# SnapGen Generate

Drive the SnapGen API with `scripts/snapgen.mjs` (zero-dep Node, submit → poll → download). Run commands from this skill's directory, or use the script's absolute path. Full flag list in the script's header comment; video families accept `--duration`, `--resolution`, `--mode`, etc. as generic passthrough. Requests are async: submit returns a job `uuid`; the script polls `history/{uuid}` until status 2 (completed) / 3 (failed), prints result URLs + `used_credit`, and downloads files.

## Reference images — ATTACH with `--files`, don't describe

**The #1 recurring mistake: the user has a reference image and you generate from a text prompt instead of attaching it.** Whenever the user gives, pastes, or points at an image and wants something _like it_ — "make it like this", "similar to", "match this", "a variant of this reference", "based on our logo/brand", "edit / restyle this" — **attach the image**. Reference-led generation is the default the moment a reference exists. The model sees the image and imitates it far better than any prose description can. If the user asks "did you attach the image?", that means you probably didn't — check before doing anything else.

How to attach (the script blob-uploads local paths in `files`, `ref_images`, `ref_videos`, `ref_audios`; entries that are URLs or bare UUIDs pass through as strings; `file_urls` sends hosted URLs; any other flag is a plain string and will NOT upload a local file):

- `image` (nano-banana-2 / nano-banana-pro): `--files a.png,b.png` (local, uploaded) **or** `--file_urls https://…,https://…` (hosted).
- `gpt-image`: `--files ref.png` (reference / image-edit). Different backend — stays up when Gemini is throttled.
- `grok-image` / `meta-image`: `--files` refs are supported per the docs (updated 2026-04), plus `--ref_history`. Still unproven for reference fidelity here — nano/gpt-image stay the default for "like this" work.
- `video seedance`: `--ref_images` (1–2 images, local or URL); `seedance-2-omni` also takes `--ref_videos` (1, ≤15s/60MB) and `--ref_audios` (1, ≤15s) — local paths upload.
- `video veo`: `--ref_images` — 1–2 as start/end frames (`--mode_image frame`, default) or up to 3 with `--mode_image ingredient`; local or URL. The API is deprecating `files`/`file_urls`/`ref_history` for veo — use `ref_images`.
- `video kling`: `--ref_images` (local) and `--ref_videos` (**required** for the motion-control/edit models).
- `video grok`: pick ONE method per request — `--files` (local), `--file_urls` (hosted), or `--ref_images` (**history UUIDs**, not files); priority files > file_urls > ref_images, the rest are ignored.
- `video sora`: single reference only, via `--files` / `--file_urls` / `--ref_history` (plural names, but the API takes one image).
- **Multiple refs = comma-separated in ONE flag** (`--files a.png,b.png`), not a repeated flag.
- **Iterating on a previous SnapGen result?** Reference an earlier generation by its uuid (from `history`), no re-upload needed: `--ref_history <uuid>` on gpt-image/grok-image/meta-image/sora, `--ref_histories <uuid>` (plural) on `image` (nano), `--ref_images <uuid>` on `video grok`.

**When a reference is attached, keep the prompt SHORT and let the image lead.** State only the delta ("same style, gold instead of silver", "empty frame, no card inside — just the border"). Over-constraining with heavy text (exact hex fills, long feature lists, rigid layout rules) fights the reference and yields worse, uglier output than a light prompt + the image. If a result looks wrong and a reference exists, suspect a missing/ignored attachment before rewriting the prompt.

**User-pasted chat images aren't files on disk.** Save one first, then pass that path to `--files`:
`powershell -STA -NoProfile -File scripts/save-clip.ps1 docs/research/ref.png` (pulls `Get-Clipboard -Format Image`), or curl a URL. The `-STA` flag is required or clipboard image access returns nothing.

## Prompt discipline

These models behave like the Gemini/GPT image models — the same rules as any good image prompt:

- **Short beats long.** Keep prompts ≈ under 200 tokens. Long, clause-stacked prompts distort output. A tight "subject + setting + style + lighting" line outperforms a paragraph.
- **With a reference, prompt the DELTA, not the whole image.** "same style, gold not silver, empty window" — not a full re-description of what's already in the attached image. Re-describing fights the reference (this is the #1 cause of "it looks worse than the reference").
- **Phrase positively.** "empty window, clean border" beats "NO card, NO label, NO dividers, zero texture." Piles of negatives confuse more than they constrain. Use a negative only when there's no positive way to say it (e.g. a chroma-key `FLAT SOLID MAGENTA #FF00FF` window — that one's structural).
- **IP / trademark safety.** Real characters or brand marks (Pokémon, PSA, a named athlete, a logo you don't own) risk an `ip_detected`/safety failure and produce infringing art. For a slab mockup, say "a graded trading-card slab, generic holo card" — don't name Pokémon/PSA. Attach _our own_ brand asset instead when brand identity is the point.

## Measure the target BEFORE you generate

Higgsfield's core discipline is **inspect the schema and measure first, never guess dimensions** (`higgsfield model get <model>` before submitting). Do the same here — skipping it causes the generate → doesn't-fit → re-roll → squeeze death-spiral. On any task where the output must FIT something (a card slab, a container, a layout box):

1. **Know the model's aspect enum — it's a fixed set, not free-form.** nano: `1:1 16:9 9:16 4:3 3:4`; gpt-image: `1:1 16:9 9:16 4:3 3:4 21:9 3:2 2:3`; grok/meta take `--orientation landscape|portrait|square` instead. If your target aspect isn't in the list, the model **cannot** produce it. Pick the nearest and plan to crop, or build procedurally.
2. **Measure the real target first, from the codebase — don't eyeball.** In THIS repo the graded slab is `SLAB_ASPECT = 1462/2446 ≈ 0.598`, the card window is the `SLAB_WINDOW` insets, and `composeSlab()` in `backend/.../admin/media/bake-slab.ts` is the ONE source of truth for how a card sits in a slab. **No** model aspect equals 0.598 (9:16=0.5625 and 2:3=0.667 bracket it), so a slab-fitting frame will never hug natively from a raw generation.
3. **When the model can't hit the size, construct — don't squeeze.** Generate the _look_ (holo / foil / glitter) on flat magenta, then build the asset to the measured geometry with sharp: key the magenta and wrap/crop to the exact target rect. Non-uniform squeezing to force a fit distorts the art; a procedural ring/mask at the measured size fits by construction and is reusable per-card. See `references/workflows.md` → "Overlay that must fit a fixed target (slab)".

## Bootstrap

1. `SNAPGEN_API_KEY` must be set in the environment, or in a `.env` (gitignored) in the cwd or skill root — the script auto-loads it. Missing → ask the user to set it (never paste keys into chat; the value must never appear in output). Keys are created/regenerated at snapgen.ai → Profile → Service Integration → API keys. Run from the repo root so the root `.env` is found.
2. Verify + show balance: `node scripts/snapgen.mjs account`

## Workflow

1. **Pick the model** from the quick reference below (details: `references/model-catalog.md`). User names a model → use it. Reference-led image → `nano-banana-2` (draft) / `nano-banana-pro` (text fidelity) / `gpt-image` (hero quality or Gemini throttled). Don't default reference work to `grok-image`/`meta-image` — they accept refs per the docs but fidelity is unproven here.
2. **Attach references** (`--files` / `--file_urls` / `--ref_images` — see the section above). Pasted chat image → save via `scripts/save-clip.ps1` first.
3. **Validate spend-free** with `--dry-run` when the command is new or pricey (`gpt-image` high/2K+, any video) — confirm the reference shows as `<file>` and params are right.
4. **Submit ONE job at a time** and let the script wait; save straight to the destination with `--out docs/research` (drafts) — never leave `snapgen-*.png` litter in the repo root. Slow video: `--no-wait` now, `wait <uuid>` later.
5. **Deliver**: rename to a meaningful filename, show the image/URL, report `used_credit` (+ remaining balance after big spends). Iterate cheap → re-render only the winner at high res.

## UX rules

- Print the media URL / saved file path, not raw JSON or job internals.
- Report `used_credit` after each generation.
- Don't pre-optimize for cheaper models unless asked; match resolution to final display size (a 36px wordmark does not need 2K).
- `--dry-run` prints the exact request without sending — use it to validate params before spending credits. The script also warns locally (`warn: …`) when `aspect_ratio`/`resolution`/`mode`/`orientation` isn't a known value for that endpoint — fix the typo before submitting.
- Output flags: `--out <dir>` (download destination, default cwd), `--no-download` (URLs only), `--no-wait` (submit and detach).

## Model quick reference

| Task                              | Command                                                        | Models                                                                                                                                                                                                                                                                                                                                                                                                                       | Cost (USD)                                |
| --------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Default image (fast, cheap, refs) | `image "p" --model nano-banana-2`                              | `nano-banana-pro` (Gemini 3 Pro, best text rendering), `nano-banana-2` (Flash, fast)                                                                                                                                                                                                                                                                                                                                         | ~$0.015                                   |
| High-fidelity image / typography  | `gpt-image "p" --mode high --resolution 2K`                    | modes `low`(default)\|`medium`\|`high`, res `1K`–`12K` (`2K` default), 8 aspect ratios incl `21:9 3:2 2:3`; Premium plan                                                                                                                                                                                                                                                                                                     | $0.03–0.47+ by mode·res                   |
| Cheapest image                    | `grok-image "p"`                                               | grok — `--mode SPEED\|QUALITY`, `--num_result 1-8` (≤4 in QUALITY), `--orientation`, refs via `--files`/`--ref_history` (unproven fidelity — prefer nano/gpt for refs)                                                                                                                                                                                                                                                       | ~$0.01                                    |
| Meta AI image                     | `meta-image "p" --orientation portrait`                        | meta-ai-image — `--num_result 1-4`, `--orientation`, refs via `--files`/`--ref_history`                                                                                                                                                                                                                                                                                                                                      | —                                         |
| Video: Veo family                 | `video veo "p" --model veo-3.1`                                | `veo-3.1`, `veo-3.1-fast`, `veo-3.1-lite`, `veo-2`, `omni-flash` (10s/edit)                                                                                                                                                                                                                                                                                                                                                  | $0.02–0.50/video                          |
| Video: Sora                       | `video sora "p" --model sora-2`                                | `sora-2` (10/15s), `sora-2-pro` (25s), `sora-2-pro-hd` (15s); `--resolution small` (720p, only option for 2/pro) \| `large` (1080p, pro-hd only); `--aspect_ratio landscape\|portrait`                                                                                                                                                                                                                                       | —                                         |
| Video: Seedance                   | `video seedance "p" --model seedance-2`                        | `seedance-2` (modes `fast\|pro`), `seedance-2-omni` (adds `fast-2\|pro-2\|fast-vip\|pro-vip`); duration 4–15s; `ref_images` (1-2), omni adds `ref_videos/ref_audios` (1 each, ≤15s)                                                                                                                                                                                                                                          | per-second by mode (e.g. pro-2 ≈ 20 cr/s) |
| Video: Kling                      | `video kling "p" --model kling-video-3-0 --duration 5`         | `kling-video-3-0` (≤15s), `-2-6` (audio), `-2-5` (relax=cheapest), `-2-1-5s`/`-2-1-10s` (fixed dur), `-o1`, `-motion-3`/`-motion`, `-3-0-edit`/`-o1-edit`, `-lipsync`; mode `standard` (720p, default) \| `professional` (1080p) \| `professional_audio` (1080p+voice, 2-6 only) \| `relax` (720p cheapest, 2-5 only); duration 3–15s; prompt ≥10 chars; motion/edit models need `--ref_videos` (`--ref_images` recommended) | ~$0.015–0.08/s                            |
| Video: Grok                       | `video grok "p" --model grok-3`                                | `grok-3` (alias of default `grok-video`); `--aspect_ratio landscape\|portrait\|square`; `--duration` (default 6); `--resolution 480p`(default)\|`720p`; `--mode` (default `custom`)                                                                                                                                                                                                                                          | $0.02–0.05/video                          |
| Video: Meta AI                    | `video meta "p"`                                               | `meta-ai-video` (default); `--orientation landscape\|portrait\|square`, `--duration` (default 5); refs via `--files`/`--ref_history`. In the API spec, no docs page — `--dry-run` first                                                                                                                                                                                                                                      | —                                         |
| Extend a video                    | `extend <veo\|grok\|seedance\|kling> "p" --ref_history <uuid>` | continues a previous generation; seedance/kling take `--mode fast` (default), grok takes `--duration/--mode/--resolution`, veo takes `--last_frame`                                                                                                                                                                                                                                                                          | —                                         |
| Grok storyboard                   | `storyboard '<scenes JSON>'`                                   | multi-scene grok video; positional arg is a **JSON array** `[{"prompt":"…","duration":6,"mode":"custom"},…]` — 2–10 scenes, ≤45s total, scene N's last frame auto-chains into N+1; `--aspect_ratio landscape\|portrait\|square`, `--resolution 480p\|720p` (1080p auto-downgrades), refs via `--files`/`--ref_history`                                                                                                       | —                                         |
| Balance                           | `account`                                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                         |
| Job status / resume               | `status <uuid>` / `wait <uuid>`                                | —                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                         |
| Recent jobs                       | `history [--filter_by image]`                                  | —                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                         |

Image params shared by `image`: `--aspect_ratio 1:1|16:9|9:16|4:3|3:4`, `--resolution 1K|2K|4K`, `--style` (e.g. `Photorealistic`, `Illustration`, `3D Render` — 15+), `--number_of_images N`, `--output_format png|jpeg`, refs via `--files a.png,b.png` (local) or `--file_urls u1,u2`.

Video generation params vary per family — pass any documented field as `--key value` (generic passthrough). Veo notes: models `veo-3.1|veo-3.1-fast|veo-3.1-lite|veo-2|omni-flash`; duration enum `4|6|8` (+`10` omni-flash only); resolution `720p|1080p` (veo-2: 720p only); `--mode_image frame|ingredient`; omni-flash also takes `--ref_videos` and `--voice_media_id` (voice list: `GET /uapi/v1/video-gen/veo/voice`, unwrapped — curl it). The docs site is a JS-rendered SPA — `curl`/WebFetch get an empty shell; the full source (incl. `openapi.json`) is downloadable via the docs "Download docs" button.

## Gotchas

- `nano-banana-pro` is rate-limited (5/min, 100/h, 1000/day); other models are not.
- **Gemini backend congestion:** `nano-banana-2` and `nano-banana-pro` run on Google's Gemini backend and can fail with `RESOURCE_EXHAUSTED` / `GEMINI_RATE_LIMIT` ("please come back in N minutes") during server-wide traffic — transient, NOT your prompt or credits. Failed jobs (status 3) cost **0 credits**, so a retry is free. If you need a reference-led image _right now_ while Gemini is throttled, fall back to `gpt-image` (separate backend, stays up, but pricier); otherwise wait out the window.
- Results expire (~30 days, `expired_at`) — the script downloads by default; keep masters locally.
- `generate_image` requires `--model`; the script defaults it to `nano-banana-2`.
- **No native transparency.** `--output_format png` is just the container — every endpoint renders an opaque canvas, and no endpoint exposes OpenAI's `background: transparent` (verified against `openapi.json`). Prompting "transparent background" paints a fake checkerboard. **Fix: pass `--transparent`** (image commands only) — the script injects the flat-magenta background, forces png, and keys the download to a subject-trimmed `<file>-alpha.png` (despill + speckle cleanup; needs `sharp` — run from the repo root, or set `SHARP_PATH`). Slab-specific geometry still goes through `scripts/process-slab-frame.mjs` (`workflows.md` → chroma-key pipeline).
- Status polling: 0 = pending (queued), 1 = processing, 2 = completed, 3 = failed. The script waits through 0/1; on failure it prints `error_code` + `error_message` and exits 1; **failed jobs cost 0 credits.**
- **Safety rejections** (`nsfw`, `ip_detected`, content policy) come back as status 3 — this is a prompt-content problem, not a transient error. Rephrase / drop the trademark; retrying the same prompt won't help.
- **HTTP 429 / anti-bot (captcha/HTML body)** → back off ~30s and retry; it's throttling, not your request.
- **Long jobs:** the script waits up to 15 min (`SNAPGEN_TIMEOUT_MS`). For slow video, submit with `--no-wait`, then rejoin later with `wait <uuid>` (or inspect with `status <uuid>`). Validate params spend-free with `--dry-run` first.
- 401 `API_KEY_REQUIRED` / `API_KEY_NOT_FOUND` → key missing/wrong in env, re-check with `account`.
- Credits are non-expiring; buying credits is what unlocks API access ("Premium").

## Reference docs

Load on demand:

- `references/model-catalog.md` — picking the image/video model; costs; the Gemini-vs-gpt-image backend split.
- `references/playbooks.md` — Higgsfield-class product features done here: product-photoshoot modes, marketplace card sets, ads/UGC, character consistency. **Load this whenever the task is a product/brand/ad visual** — the templates replace Higgsfield's backend prompt enhancer.
- `references/media-inputs.md` — exactly what the script uploads (media keys with URL/UUID pass-through vs plain fields), per-command reference support, pasted-image capture.
- `references/prompt-engineering.md` — short prompts, delta-not-redescribe, positive phrasing, IP/trademark safety, per-model image tips, and **per-family video prompting** (kling's word budget, seedance multi-shot timed beats, veo audio/dialogue cues, sora beat style). **Load before any video prompt.**
- `references/workflows.md` — reference-led variants, the chroma-key overlay pipeline (`process-slab-frame.mjs`), crop-to-asset, video + resume, housekeeping.
- `references/troubleshooting.md` — statuses, safety rejects, rate limits / anti-bot, timeouts & resume, result handling.

## Self-check

`node scripts/test.mjs` — runs against a local mock (no key, no credits spent).
