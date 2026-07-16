# Media Inputs

How reference images/videos/audio attach to a SnapGen request. Grounded in `scripts/snapgen.mjs` → `buildForm()`, which is the only thing that turns a flag into an uploaded file.

## What the script actually uploads

`buildForm` treats the media keys `files`, `ref_images`, `ref_videos`, `ref_audios` specially — comma-split, then per entry: a **local path is blob-uploaded**, while a **URL (`https://…`) or bare UUID passes through as a string** (veo/seedance accept URL entries in `ref_images`; grok video's `ref_images` are history uuids). Everything else:

| Flag                                                                           | Behaviour                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--files a.png,b.png` / `--ref_images …` / `--ref_videos …` / `--ref_audios …` | Comma-split; local paths uploaded, URLs/UUIDs sent as strings.                                                                                                                                                                                                                                         |
| `--file_urls https://…,https://…`                                              | Comma-split, each sent as a **URL string** (no upload).                                                                                                                                                                                                                                                |
| `--ref_history <uuid>`                                                         | Plain string (correct — nothing to upload). References a **previous SnapGen generation** as the image reference. Accepted by `gpt-image`, `grok-image`, `meta-image`, `video sora/meta`, extends, storyboard. Nano's `generate_image` uses the **plural** `--ref_histories`. Find uuids via `history`. |
| any other `--key value`                                                        | `form.set(key, value)` — a plain string. **A local path here is NOT uploaded**, it's sent literally.                                                                                                                                                                                                   |

## Per-command reference support

| Command                                   | Endpoint                | Refs                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image` (nano-banana-2 / nano-banana-pro) | `generate_image`        | `--files` (upload), `--file_urls` (hosted), `--ref_histories <uuid>` (plural — previous generations). Multiple refs = comma-separated.                                                                                                                                                              |
| `gpt-image`                               | `imagen/gpt-image-2`    | `--files ref.png` or `--ref_history`. Different backend from nano — stays up when Gemini throttles.                                                                                                                                                                                                 |
| `grok-image`                              | `imagen/grok`           | `--files` (upload) or `--ref_history` (docs updated 2026-04; was text-only). Also `--mode SPEED\|QUALITY`, `--num_result 1-8`, `--orientation`. Ref fidelity unproven here — prefer nano/gpt for "make it like this." (A v2 endpoint `uapi/v2/imagen/grok` takes `ref_images` instead — unwrapped.) |
| `meta-image`                              | `meta_ai/generate`      | `--files` (upload) or `--ref_history`. `--num_result 1-4`, `--orientation landscape\|portrait\|square`.                                                                                                                                                                                             |
| `video veo`                               | `video-gen/veo`         | `--ref_images` — 1–2 start/end frames (`--mode_image frame`, default) or ≤3 (`--mode_image ingredient`); local or URL. `files`/`file_urls`/`ref_history` are being deprecated by the API for veo. `omni-flash` only: `--ref_videos`, `--voice_media_id`.                                            |
| `video sora`                              | `video-gen/sora`        | ONE image via `--files` / `--file_urls` / `--ref_history` (plural names, single image accepted).                                                                                                                                                                                                    |
| `video seedance`                          | `video-gen/seedance`    | `--ref_images` 1–2 (local or URL). `seedance-2-omni` only: `--ref_videos` (1, mp4/webm ≤15s/60MB), `--ref_audios` (1, mp3/wav ≤15s) — local paths upload. No `file_urls` param.                                                                                                                     |
| `video kling`                             | `video-gen/kling`       | `--ref_images` (local, repeated OK via comma). `--ref_videos` **required** for motion-control/edit models (`-motion-3`, `-motion`, `-3-0-edit`, `-o1-edit`; ref_images recommended there, duration ignored). `-lipsync` takes both as optional.                                                     |
| `video grok`                              | `video-gen/grok`        | ONE method per request: `--files` (local) > `--file_urls` (hosted) > `--ref_images` (**history uuids**) — extras ignored.                                                                                                                                                                           |
| `video meta`                              | `video-gen/meta`        | `--files`, `--file_urls`, or `--ref_history`.                                                                                                                                                                                                                                                       |
| `extend <fam>`                            | `video-extend/*`        | `--ref_history <uuid of the source video job>` (required) + `"prompt"`.                                                                                                                                                                                                                             |
| `storyboard`                              | `video-storyboard/grok` | positional arg = `scenes` **JSON array** (`[{"prompt":"…","duration":6,"mode":"custom"},…]`, 2–10 scenes, ≤45s total); refs via `--files`/`--ref_history`.                                                                                                                                          |

## Multiple references

Comma-separated **in one flag**, not a repeated flag:

```text
--files hero.png,logo.png,swatch.png
```

(Unlike Higgsfield's `--image a --image b` repeat pattern — SnapGen's `buildForm` splits on comma.)

## Pasted chat images

An image pasted into chat reaches the model as pixels, not a file on disk. Save it first, then pass the path to `--files`:

```powershell
powershell -STA -NoProfile -File scripts/save-clip.ps1 docs/research/ref.png
node scripts/snapgen.mjs image "same style, empty window" --files docs/research/ref.png --model nano-banana-2
```

`-STA` is mandatory — without it `Get-Clipboard -Format Image` returns nothing. For an image at a URL, `curl -o docs/research/ref.png <url>` instead.

## Validate before spending

`--dry-run` prints the exact multipart request (files shown as `<file>`) and sends nothing — confirm the reference is actually attached before spending credits.
