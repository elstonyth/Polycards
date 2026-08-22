# Plan 114: Harden the Telegram apex board — guarded image fetch, complete fallback chain, HTML-safe clamp, documented env

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 30eded61..HEAD -- backend/packages/api/src/modules/packs/telegram.ts backend/packages/api/src/api/admin/media/bake-slab.ts backend/packages/api/src/modules/packs/__tests__/telegram.unit.spec.ts backend/packages/api/.env.template`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security + bug
- **Planned at**: commit `30eded61`, 2026-08-22

## Why this matters

The Telegram apex board (PRs #469–#471) posts every Legendary+ pull to the
public POLYCARDS.GG channel. Four defects, all confirmed by reading the code:

1. **SSRF/resource gap**: `blackBackedPhoto` fetches the card image with a
   bare `fetch` — default redirect-following, no host validation, no byte
   cap, no decode-pixel cap — and then **publishes the fetched bytes to the
   public channel**. The repo already built the guarded fetcher for exactly
   this class of URL (`fetchBytes` in `bake-slab.ts`: host allowlist,
   manual redirect walking with per-hop re-validation, 20 MB byte cap) and
   its comment names the precise bypass the new call site reopens.
2. **Fallback hole**: both photo send paths can **throw** (network error,
   `AbortSignal.timeout`, non-JSON 5xx body from an edge proxy), and a
   throw escapes `sendApexPost` before the documented `sendMessage` text
   fallback — a transient blip during the 30s photo upload drops the post
   entirely, while the function's own doc comment says the text fallback
   "covers a failed photo entirely".
3. **Self-defeating clamp**: the 1024-char caption clamp slices an
   already-HTML-escaped string mid-tag or mid-entity; every send uses
   `parse_mode: 'HTML'`, so the truncated caption is rejected by Telegram's
   parser — the clamp _causes_ the 400 it exists to prevent, and the
   fallback then retries the same broken caption.
4. **Undocumented env**: the four `TELEGRAM_*` vars exist only in
   `telegram.ts`'s header comment; `backend/packages/api/.env.template` has
   zero `TELEGRAM` entries, while `scripts/do-apply.ps1` now hard-fails a
   backend apply when the token is missing.

(A fifth, smaller item — Telegram 429s are dropped without a retry even
though a 429 is an explicit non-delivery — is included as an optional step
with a strict bound.)

## Current state

Files:

- `backend/packages/api/src/modules/packs/telegram.ts` — the whole board:
  config header (:15–29), `escapeHtml` (:86–97), `buildApexCaption`
  (:124–157, clamp at :153–156), `callTelegram` (:182–194),
  `blackBackedPhoto` (:217–229), `uploadApexPhoto` (:234–252),
  `sendApexPost` (:261–285), `postApexPull` (:327–436).
- `backend/packages/api/src/api/admin/media/bake-slab.ts` — the guarded
  fetcher: `isAllowedImageUrl` (:137–153), `assetOrigin` (:159–160),
  `fetchBytes` (:164–205), `MAX_DECODE_PIXELS = 32_000_000` (:54),
  `FETCH_TIMEOUT_MS = 10_000` (:42), `IMAGE_RULES.maxBytes` (byte cap used
  at :200).
- `backend/packages/api/src/modules/packs/__tests__/telegram.unit.spec.ts`
  — existing suite; clamp test at :69–73 asserts only `length <= 1024`.
- `backend/packages/api/.env.template` — env documentation; currently no
  `TELEGRAM` keys.

Excerpts as of `30eded61`:

`telegram.ts:217-229` (the unguarded fetch — defect 1):

```ts
export async function blackBackedPhoto(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const flattened = await sharp(Buffer.from(await res.arrayBuffer()))
      .flatten({ background: PHOTO_BACKGROUND })
      .jpeg({ quality: 90 })
      .toBuffer();
    return flattened.byteLength > PHOTO_UPLOAD_LIMIT ? null : flattened;
  } catch {
    return null;
  }
}
```

`telegram.ts:261-285` (`sendApexPost` — defect 2; note nothing catches a
throw from `uploadApexPhoto` or `callTelegram`):

```ts
export async function sendApexPost(
  token: string,
  chatId: string,
  caption: string,
  photoUrl: string | null,
): Promise<TelegramResult> {
  if (photoUrl) {
    const bytes = await blackBackedPhoto(photoUrl);
    const photo = bytes
      ? await uploadApexPhoto(token, chatId, caption, bytes)
      : await callTelegram(token, 'sendPhoto', {
          chat_id: chatId,
          photo: photoUrl,
          caption,
          parse_mode: 'HTML',
        });
    if (photo.ok) return photo;
  }
  return callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text: caption,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}
```

`telegram.ts:153-156` (the clamp — defect 3; `caption` already contains
`<b>`, `<a href="…">` and `&amp;`-class entities at this point):

```ts
const caption = lines.join('\n');
return caption.length > CAPTION_LIMIT
  ? `${caption.slice(0, CAPTION_LIMIT - 1)}…`
  : caption;
```

`bake-slab.ts:164-171` (the guarded fetcher — already exported; note the
relative-path resolution against the storefront origin):

```ts
export const fetchBytes = async (url: string): Promise<Buffer | null> => {
  // Fail closed (null → caller warns + falls back …)
  if (!isAllowedImageUrl(url)) return null;
  // isAllowedImageUrl passes storefront-relative paths, but Node's fetch()
  // throws on them — resolve against the trusted storefront origin …
  let target = url.startsWith('/') ? `${assetOrigin()}${url}` : url;
```

Repo conventions that matter here:

- `modules/packs/*` importing from `api/utils/*` is an established pattern
  (`service.ts:78` imports `pageAll` from `../../api/utils/page-all`;
  `globepay-withdrawal.ts:13` imports from `../../api/utils/rate-limit`).
  Importing from `api/admin/media/` would be new — so Step 1 moves the
  fetcher into `api/utils/` and re-exports it from `bake-slab.ts`.
- `postApexPull` NEVER throws and never retries, because an event-bus
  redelivery would be a duplicate public post (`telegram.ts:315-317`).
  Nothing in this plan may change that outer contract.
- Backend eslint is **vacuous** for `packages/api` (root eslint config
  carries `globalIgnores(['backend/**'])` and packages/api has no config of
  its own) — typecheck + jest are the real gates.

## Commands you will need

Run from `backend/` unless stated. jest 30 uses `--testPathPatterns`
(plural — the singular flag was removed).

| Purpose               | Command                                                                                                                                                                                    | Expected on success |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Typecheck (api)       | `corepack yarn check-types`                                                                                                                                                                | exit 0              |
| Unit tier             | `node node_modules/jest/bin/jest.js --config packages/api/jest.config.js --testPathPatterns telegram` (from `backend/`; if jest resolves under `packages/api/node_modules`, use that path) | all pass            |
| Full packs unit specs | same command with `--testPathPatterns "modules/packs"`                                                                                                                                     | all pass            |
| Env template check    | `grep -c "TELEGRAM" packages/api/.env.template`                                                                                                                                            | ≥4 after Step 5     |

Do NOT run `medusa develop` for this plan; unit tests + typecheck suffice.
Never run `backend/packages/api/src/scripts/telegram-apex-smoke.ts` — it
posts to the live channel (plan 115 covers that script).

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/api/utils/image-fetch.ts` (create)
- `backend/packages/api/src/api/admin/media/bake-slab.ts` (move + re-export only)
- `backend/packages/api/src/modules/packs/telegram.ts`
- `backend/packages/api/src/modules/packs/__tests__/telegram.unit.spec.ts`
- `backend/packages/api/.env.template`

**Out of scope** (do NOT touch):

- `backend/packages/api/src/scripts/telegram-apex-smoke.ts` — plan 115.
- `backend/packages/api/src/subscribers/pack-opened-telegram.ts` — the
  subscriber contract (fire-and-forget, never throw) is correct as is.
- `.do/backend.app.yaml` — env plumbing is already live and correct.
- Any change to what the board posts (fields, wording, PII scope) — the
  caption content is settled product behavior.

## Git workflow

- Branch: `advisor/114-telegram-board-hardening`
- Conventional commits, e.g. `fix(backend): route the apex photo fetch through the SSRF-guarded fetcher`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Move the guarded fetcher to `api/utils/image-fetch.ts`

Create `backend/packages/api/src/api/utils/image-fetch.ts` and MOVE (not
copy) these from `bake-slab.ts`, unchanged in behavior:
`isAllowedImageUrl`, `assetOrigin` (rename export to `imageAssetOrigin` if
it collides with anything; it is currently module-private, so export it or
keep it private in the new module), `MAX_REDIRECTS`, `fetchBytes`, plus the
constants they reference: `FETCH_TIMEOUT_MS`, `MAX_DECODE_PIXELS`, and the
byte cap. `IMAGE_RULES` carries more than the byte cap — if extracting it
whole drags unrelated config, define `const MAX_FETCH_BYTES = IMAGE_RULES.maxBytes`'s
literal value in the new module and have `bake-slab.ts` keep using
`IMAGE_RULES` for its other rules; state which you did in your report.
Also move `isPrivateHost` and `localFileOrigin` if they live in
`bake-slab.ts` (follow the imports; they may already be elsewhere — keep
their current home if so).

In `bake-slab.ts`, import the moved symbols from
`../../utils/image-fetch` and **re-export** `isAllowedImageUrl` and
`fetchBytes` so every existing importer keeps working:

```ts
export { isAllowedImageUrl, fetchBytes } from '../../utils/image-fetch';
```

Find all existing importers first:
`grep -rn "from.*bake-slab" backend/packages/api/src --include=*.ts` — they
must all still compile without edits.

**Verify**: `corepack yarn check-types` (from `backend/`) → exit 0.
Bake-slab's own tests (if any) still pass:
`--testPathPatterns "bake-slab|media"` → all pass or "no tests found".

### Step 2: Route `blackBackedPhoto` through `fetchBytes` and cap the decode

In `telegram.ts`, replace the body of `blackBackedPhoto`:

```ts
export async function blackBackedPhoto(url: string): Promise<Buffer | null> {
  try {
    const bytes = await fetchBytes(url);
    if (!bytes) return null;
    const flattened = await sharp(bytes, {
      limitInputPixels: MAX_DECODE_PIXELS,
    })
      .flatten({ background: PHOTO_BACKGROUND })
      .jpeg({ quality: 90 })
      .toBuffer();
    return flattened.byteLength > PHOTO_UPLOAD_LIMIT ? null : flattened;
  } catch {
    return null;
  }
}
```

Import `fetchBytes` and `MAX_DECODE_PIXELS` from
`../../api/utils/image-fetch` (matches the existing `modules → api/utils`
convention cited above). Keep the null-on-any-failure contract and the
doc comment; extend the comment with one line: the fetch is now
host-validated and redirect-checked, so a blocked URL degrades to the URL
photo fallback exactly like an unreachable one.

Behavior note to record (not to "fix"): `fetchBytes` resolves
storefront-relative paths against `STOREFRONT_URL` — a relative
`card.image` previously threw inside `fetch` and fell to the URL fallback;
now it may fetch successfully via the storefront origin. That is an
improvement, not a regression.

**Verify**: `corepack yarn check-types` → exit 0.
`grep -n "await fetch(" backend/packages/api/src/modules/packs/telegram.ts`
→ the only remaining raw `fetch` calls are in `callTelegram` (:187) and
`uploadApexPhoto` (:245), both to the hardcoded `api.telegram.org`.

### Step 3: Close the throw hole in `sendApexPost`

Wrap each photo attempt so a rejection becomes an `ok: false` result and
control reaches the existing `sendMessage` fallback. Smallest shape:

```ts
const attempt = async (p: Promise<TelegramResult>): Promise<TelegramResult> =>
  p.catch((err) => ({
    ok: false,
    description: err instanceof Error ? err.message : String(err),
  }));
```

…and use `await attempt(uploadApexPhoto(…))` / `await attempt(callTelegram(token, 'sendPhoto', …))`
for the two photo paths. Do NOT wrap the final `sendMessage` — its throw
must keep propagating to `postApexPull`'s catch (that is the "post failed"
log path, and swallowing it would silently return `ok:false`-less garbage).
Update the function's doc comment: the text fallback now genuinely covers
"a failed photo entirely", including a thrown one.

**Verify**: `corepack yarn check-types` → exit 0. New spec in Step 6 covers it.

### Step 4: Make the clamp HTML-safe — clip each ESCAPED field, entity-aware

The bug is that the final `caption.slice(0, 1023)` can cut through a `<b>`
tag or a `&quot;` entity, and every send is `parse_mode: 'HTML'`, so the
truncated caption 400s. The fix is ONE deterministic scheme — do not
reason about escape-expansion factors, measure the fixed part instead:

**4a. Add an entity-safe clip helper** near `CAPTION_LIMIT`. It operates on
an ALREADY-ESCAPED string and never leaves a dangling `&…` (an entity with
no closing `;`):

```ts
/** Clip an already-HTML-escaped, tag-free field to `max` visible-ish chars
 *  without bisecting an entity. Fields carry entities (&amp; &lt; &gt;
 *  &quot;) but NO tags — tags are added by buildApexCaption around these
 *  clipped values — so the only hazard is cutting mid-entity, which we undo
 *  by trimming back to before a trailing `&` that has no following `;`. */
function clipEscaped(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;
  let cut = escaped.slice(0, max);
  const amp = cut.lastIndexOf('&');
  if (amp !== -1 && !cut.slice(amp).includes(';')) cut = cut.slice(0, amp);
  return `${cut}…`;
}
```

**4b. Measure the scaffolding, derive the budget.** The scaffolding is the
fixed template text (emoji, `<b>`/`<a>` tags, labels, the two URL lines,
newlines) — everything in `buildApexCaption` that is NOT one of the five
variable fields. The executor computes it ONCE, empirically, rather than
estimating: assemble the caption with all five fields set to `''` and the
real `profileUrl`/`siteUrl`, read `.length`. Add a small safety margin and
the ellipsis budget, then split the remainder across the five fields:

```ts
// PER_FIELD is derived, not guessed. Measure the scaffolding once (see the
// spec test below: buildApexCaption with all five fields '' — that length
// is the fixed cost, tags + URLs + labels included) and set:
//   PER_FIELD = Math.floor((CAPTION_LIMIT - SCAFFOLD_MAX - 5) / 5)
// SCAFFOLD_MAX accounts for the longest realistic profileUrl/siteUrl. With
// CAPTION_LIMIT 1024 and scaffolding well under 300, PER_FIELD lands ~140,
// so any single field of ~140 escaped chars fits and the total cannot reach
// 1024. Pin SCAFFOLD_MAX and PER_FIELD as consts with the measured number
// in a comment; the test in Step 7 fails if the scaffolding ever grows past
// what SCAFFOLD_MAX reserves, which is the guard against silent drift.
const SCAFFOLD_MAX = 320; // measured 2026-08-DD: <NNN>; margin to 320
const PER_FIELD = Math.floor((CAPTION_LIMIT - SCAFFOLD_MAX - 5) / 5); // ~139
```

**4c. Apply it.** In `buildApexCaption`, escape each field as today, then
wrap each escaped value in `clipEscaped(…, PER_FIELD)` BEFORE it goes into
the `<b>`/`<a>` tag or a line. Fields: `who` (before it is wrapped in the
`<a>`), `cardName`, `grade`, `set`, `packTitle`. Do NOT clip
`profileUrl`/`siteUrl` (operator config; a clipped URL is broken — they are
what `SCAFFOLD_MAX` reserves for). Keep the existing final
`caption.length > CAPTION_LIMIT ? slice…` line as a belt-and-braces guard,
but it is now unreachable for any input the budgets allow — and even if it
ever fired, note that it could still bisect (that is why 4a+4b exist to
make it unreachable; do not rely on the slice for correctness).

Because every field is bounded to ~139 and there are five of them
(5 × 139 = 695) plus scaffolding ≤ 320, the assembled caption is
≤ 1015 < 1024 by construction — one inequality, no expansion factor.

**Verify**: `corepack yarn check-types` → exit 0. Step 7's clamp cases
(valid HTML, no bisected entity, ≤1024) pass. If your measured scaffolding
exceeds ~300, recompute `PER_FIELD` from the real number and note it — the
scheme holds for any measured value, only the constant changes.

### Step 5: Document the env in `.env.template`

Append to `backend/packages/api/.env.template`, next to the other
integration keys (Resend etc.), with values left EMPTY:

```
# ── Telegram apex board (Legendary+ pulls → public channel) ──────────────
# All four optional: unset = feature off (dev/CI default). See
# src/modules/packs/telegram.ts header for full semantics.
TELEGRAM_BOT_TOKEN=
# Numeric channel id (e.g. -100…). Quote it in YAML specs — leading '-'.
TELEGRAM_CHAT_ID=
# Lowest posted tier. Default Legendary. NOTE: RARITY_ORDER puts Mythical
# BELOW Legendary — set 'Mythical' to WIDEN the board by one tier.
TELEGRAM_MIN_RARITY=
# Storefront origin for profile links. Default https://polycards.gg.
TELEGRAM_SITE_URL=
```

**Verify**: `grep -c "TELEGRAM" backend/packages/api/.env.template` → ≥ 4.
No secret value anywhere in the diff (`git diff` — keys only, all empty).

### Step 6 (optional but recommended): Bounded single retry on 429

In `postApexPull`, after `sendApexPost` returns non-ok: Telegram encodes
rate limits as `error_code: 429` with `parameters.retry_after` seconds. A
429 means the message was NOT delivered, so one retry cannot duplicate.
Extend `TelegramResult` with the two optional fields, and in the non-ok
branch: if `error_code === 429`, wait `min(retry_after, 5)` seconds
(`await new Promise(r => setTimeout(r, ms))`), then call `sendApexPost`
once more; log a warn either way. Hard bounds: exactly ONE retry, ceiling
5s — this runs inside an event-bus worker slot and must not back up under
a rate-limit storm. If `error_code`/`parameters` complicate the
`res.json()` typing, keep the parse loose (`error_code?: number;
parameters?: { retry_after?: number }`).

**Verify**: `corepack yarn check-types` → exit 0; new spec case (Step 7).

### Step 7: Tests

Extend `telegram.unit.spec.ts` (model on the existing cases — the suite
mocks `fetch` globally and asserts real captions):

1. **Fallback on throw**: photo path's `fetch` REJECTS (e.g.
   `mockRejectedValueOnce(new Error('network'))`) → assert `sendMessage`
   is still called and the returned caption is intact. (Pins Step 3;
   before Step 3 this test FAILS — verify that by writing it first if you
   want the red/green proof.)
2. **Clamp validity**: a 500-char card name + 500-char pack title → the
   built caption is ≤1024 AND every `<b>`/`<a>` opened is closed and no
   entity is bisected. Concrete assertion: caption matches
   `/^[^<]*(<b>[^<>]*<\/b>|<a href="[^"]*">[^<>]*<\/a>|[^<>])*$/s` — or
   simpler and stronger: count `<b>` === count `</b>`, count `<a ` ===
   count `</a>`, and `/&[a-z]*$/.test(caption) === false` (no trailing
   half-entity). Keep the existing `length <= 1024` assertion.
3. **429 retry** (if Step 6 done): first `sendMessage` responds
   `{ ok: false, error_code: 429, parameters: { retry_after: 1 } }`,
   second responds ok → assert exactly 2 send calls and a non-null
   messageId. Use fake timers so the wait doesn't slow the suite.
4. **Guarded fetch**: `blackBackedPhoto('http://127.0.0.1/x.png')`
   resolves null WITHOUT the global `fetch` mock being called (the
   allowlist rejects before any network). This pins Step 2's wiring.

**Verify**: jest `--testPathPatterns telegram` → all pass, including ≥3
new cases (4 with Step 6). Then the full packs tier
`--testPathPatterns "modules/packs"` → all pass.

## Done criteria

- [ ] `corepack yarn check-types` (backend) exits 0
- [ ] jest `--testPathPatterns telegram` → all pass, ≥3 new cases
- [ ] jest `--testPathPatterns "modules/packs"` → all pass
- [ ] `grep -n "await fetch(" backend/packages/api/src/modules/packs/telegram.ts` → matches only inside `callTelegram` and `uploadApexPhoto`
- [ ] `grep -rn "from.*bake-slab" backend/packages/api/src --include=*.ts` → every pre-existing importer unchanged and compiling
- [ ] `grep -c "TELEGRAM" backend/packages/api/.env.template` ≥ 4, all values empty
- [ ] No secret value in any diff hunk
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- Moving `fetchBytes` pulls in more than ~5 additional symbols (the
  module boundary is wrong — report the dependency chain instead of
  dragging half of bake-slab along).
- Any existing bake-slab importer needs an edit to keep compiling (the
  re-export was supposed to make this zero-touch).
- The clamp arithmetic in Step 4 doesn't close (your measured scaffolding
  length pushes the rebuilt form over 1024) — report the numbers.
- You are tempted to add a retry for any non-429 failure — that violates
  the no-duplicate-post design decision at `telegram.ts:315-317`.

## Maintenance notes

- Anyone adding a caption line must re-check the Step 4 budget arithmetic
  (the comment carries it).
- If a second module ever needs the guarded fetcher, it now lives in
  `api/utils/image-fetch.ts` — do not re-inline a bare `fetch` for image
  URLs anywhere; that is the exact regression this plan closes.
- The bake-slab header documents a residual DNS-rebind gap ("a hostname
  that RESOLVES to a private IP") with a ponytail note to add
  resolve-then-check "if this ever fetches less-trusted input". Card image
  URLs are admin-set, same trust as before — the residual stands; revisit
  only if image URLs ever become customer-suppliable.
- Reviewer: check Step 3 did NOT wrap the final `sendMessage` call.
