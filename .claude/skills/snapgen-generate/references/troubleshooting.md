# Troubleshooting

Job statuses (from `history/{uuid}.status`): **0** = pending (queued, `delay_seconds` may show the queue wait), **1** = processing, **2** = completed, **3** = failed. The script waits through 0/1; on status 3 it prints `error_code` + `error_message` and exits 1. **Failed jobs cost 0 credits**, so a retry is free.

## Check the status page first

Before debugging a failing model, check **https://snapgen.ai/status** — per-model Operational/success-rate list. The page's embedded config also carries live availability flags (`klingMaintenance`, `metaAIMaintenance`, `gptImage2Maintenance`, …): `curl -s https://snapgen.ai/status | grep -o '\w*Maintenance:\w*'`. A model in maintenance fails regardless of your request (e.g. Meta AI was `metaAIMaintenance:true` on 2026-07-17).

## Rate limits & backend congestion

- **`RESOURCE_EXHAUSTED` / `GEMINI_RATE_LIMIT` ("come back in N minutes")** — `nano-banana-2` and `nano-banana-pro` run on Google's Gemini backend; under server-wide traffic they fail transiently. Not your prompt, not your credits. Options: wait out the window, or fall back to `gpt-image` (separate backend, stays up, pricier).
- **`nano-banana-pro` hard limits:** 5/min, 100/h, 1000/day. Other models aren't per-key rate-limited.
- **HTTP 429** — too many requests; back off ~30s.
- **Anti-bot (HTML body / captcha-delivery)** — the server's CloudFlare/DataDome fired. Wait ~30s and retry; if persistent, it's server-side.

## Content / safety rejections

- **`nsfw`** — content policy. Rephrase.
- **`ip_detected`** — trademark/real-person/branded-character detected (Pokémon, PSA, a named athlete, a logo). This is a **prompt-content** failure, not transient — retrying the same prompt won't help. Drop the trademark; describe generically ("a graded trading-card slab, generic holo card") or attach our own brand asset. See `prompt-engineering.md` → IP safety.

## Auth / key / plan

- **401 `API_KEY_REQUIRED` / `API_KEY_NOT_FOUND`** — `SNAPGEN_API_KEY` missing or wrong. Re-check with `account`. The key loads from env or a `.env` in cwd / skill root; its value must never appear in argv, logs, or chat.
- **`NOT_ENOUGH_CREDIT` / `NOT_ENOUGH_AND_LOCK_CREDIT`** — balance (or balance minus locked credits of in-flight jobs) can't cover the request. Check `account`; wait for running jobs or top up.
- **`PREMIUM_PLAN_REQUIRED`** — endpoint is Premium-gated (e.g. `gpt-image`). Buying credits unlocks Premium.
- **`GEMINI_RAI_MEDIA_FILTERED`** — Google's responsible-AI filter rejected the media/prompt; a content problem like `nsfw`/`ip_detected`, not transient.
- **`TEXT_TOO_LONG` / `MAXIMUM_FILE_SIZE_EXCEED` / `FILE_TYPE_NOT_ALLOWED`** — input validation; shorten the prompt or fix the file (Kling: images JPG/PNG ≤10MB, videos MP4/MOV/WebM ≤100MB).

## Timeouts & long jobs

- The script waits up to **15 min** (`SNAPGEN_TIMEOUT_MS`, override via env). On timeout it prints the last status/percentage and exits 1 — the job may still finish server-side.
- For slow video: submit with **`--no-wait`** (prints the uuid), then rejoin later with **`wait <uuid>`**, or inspect with **`status <uuid>`**.
- Poll interval is 5s (`SNAPGEN_POLL_MS`).

## Result handling

- **"completed but no media URL"** — status 2 but `resultUrls()` found nothing. Run `status <uuid>` and inspect the raw JSON; the URL field may be under an unexpected key.
- **Download failed `<status>`** — the result URL fetch failed (expired/blocked). Result URLs expire ~30 days (`expired_at`); the script downloads by default, so keep masters locally. Re-run `status <uuid>` for a fresh URL if still within the window.
- Files save as `snapgen-<uuid8>-<i>.<ext>` in `--out <dir>` (default cwd). Use `--no-download` to only print URLs.

## HTTP errors

Any non-2xx from the API → the script dies with `HTTP <status> <path>: <detail>` (first 400 chars). Check the path and the `detail` — usually a bad param value or missing required field. Re-run with `--dry-run` to see exactly what's being sent. If the script printed a `warn: <param>="…" is not a known value` line before submitting, that's the likely culprit — it's the local enum typo-guard (verified enums per endpoint), fix the value rather than blaming the server.

Kling-specific error codes (own docs pages `…/kling-error-codes` + `…/kling-model-input`):

- **`INVALID_VIDEO_FILE`** — a motion-control/edit model (`-motion*`, `-*-edit`) was called without `--ref_videos`, or the video format is unsupported.
- **`SERVICE_PRICE_NOT_FOUND`** — invalid model×mode combination (e.g. `professional_audio` on anything but 2-6, `relax` on anything but 2-5).
- **`FILE_TOO_LARGE` / `VIDEO_DURATION_TOO_LONG`** — image >10MB, video >100MB or >120s.
- **`EMPTY_PROMPT`** — prompt missing or under the 10-char minimum.

The docs site is a JS SPA — curl/WebFetch get an empty shell; the "Download docs" button yields the full markdown + `openapi.json` (the source of truth for paths/params).
