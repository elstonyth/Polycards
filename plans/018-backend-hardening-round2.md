# Plan 018: Backend hardening round 2 — delivery batch cap + slab-bake egress allowlist

> **Executor instructions**: Follow this plan step by step. The two items are
> independent; run the verification after each. If any "STOP conditions" item
> occurs, stop and report. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- backend/packages/api/src/api/store/delivery-orders/route.ts backend/packages/api/src/api/store/vault/buyback-batch/route.ts backend/packages/api/src/api/admin/media/bake-slab.ts backend/packages/api/src/api/admin/media/ingest-pc-image.ts`
> If any file changed, re-read it and compare against the "Current state"
> excerpts before editing; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security / hardening
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

Two low-severity backend hardening items, bundled (mirrors prior plan 008):

1. **`POST /store/delivery-orders` accepts an unbounded `pull_ids` array.** It
   validates each entry is a non-empty string but never caps the array length,
   then passes it straight into a `listPulls` `IN (...)` query and pull-flip set.
   The sibling bulk-sell route caps at `MAX_BATCH = 500`; the delivery route is
   the odd one out. Not money loss (unknown ids 404 via the ownership validator)
   — an authed, rate-limited resource edge. Cheap to close.
2. **Admin-triggered blind SSRF in the slab-bake path.** `bake-slab.ts` `fetch`es
   any admin-supplied `slab_frame_url` and any card `image` URL with **no host
   allowlist** — unlike `ingest-pc-image.ts`, which restricts to an exact host +
   path prefix. Trigger requires admin auth (so severity is LOW), but it's a new
   server-side-fetch surface without the allowlist discipline the PC-image ingest
   already established. A trusted-but-careless or compromised admin could point
   the server at an internal endpoint; the fetch is blind (bytes only composited
   into an image), which limits exfiltration but not reach.

## Current state

### Item 1 — delivery batch cap

- `backend/packages/api/src/api/store/delivery-orders/route.ts:23-36` — validates
  entries, not length:

  ```ts
  const pullIds = body?.pull_ids;
  const addressId = body?.address_id;
  if (
    !Array.isArray(pullIds) ||
    pullIds.length === 0 ||
    pullIds.some((id) => typeof id !== 'string' || id.trim() === '') ||
    typeof addressId !== 'string' ||
    addressId.trim() === ''
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      '`pull_ids` (string[]) and `address_id` (string) are required.',
    );
  }
  ```

- **Exemplar** — `backend/packages/api/src/api/store/vault/buyback-batch/route.ts`:

  ```ts
  const MAX_BATCH = 500; // :36
  if (ids.length > MAX_BATCH) {
    // :91
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Cannot sell more than ${MAX_BATCH} cards at once.`,
    ); // :94
  }
  ```

### Item 2 — slab-bake egress allowlist

- `backend/packages/api/src/api/admin/media/bake-slab.ts:40` — the unguarded
  fetch helper: `const fetchBytes = async (url: string): Promise<Buffer | null>`.
- `bake-slab.ts:57-63` (`resolveFrameBytes`) fetches `slab_frame_url` when it
  matches `/^https?:\/\//` — no host check.
- `bake-slab.ts:134` fetches `card.image` (`const photo = await
fetchBytes(card.image)`) — `card.image` is validated only by
  `IMAGE_RE = /^(https?:\/\/|\/)/` in `admin/cards/validate.ts:9`.
- **Exemplar** — `backend/packages/api/src/api/admin/media/ingest-pc-image.ts:36-48`
  (`isPcImageUrl`) shows the allowlist discipline to mirror:

  ```ts
  export function isPcImageUrl(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === PC_IMAGE_HOST &&
      parsed.pathname.startsWith(PC_IMAGE_PATH_PREFIX)
    );
  }
  ```

## Commands you will need

| Purpose            | Command                                                      | Expected |
| ------------------ | ------------------------------------------------------------ | -------- |
| Backend build      | from `backend/packages/api`: `npm run build`                 | exit 0   |
| Backend HTTP tests | from `backend/packages/api`: `npm run test:integration:http` | all pass |
| Backend unit tests | from `backend/packages/api`: `npm run test:unit`             | all pass |

## Scope

**In scope:**

- `backend/packages/api/src/api/store/delivery-orders/route.ts` (add length cap)
- `backend/packages/api/src/api/admin/media/bake-slab.ts` (add egress guard to `fetchBytes`)
- A test for each (see Test plan)

**Out of scope:**

- `ingest-pc-image.ts` — already allowlisted; it's the exemplar.
- The buyback-batch route — the exemplar for item 1; do not touch.
- Legitimate storefront-relative image paths (`/…`) and the configured file/CDN
  provider — the allowlist must NOT reject these. Read how `card.image` legit
  values look (relative `/cdn/...` or the CDN host) before writing the allowlist.

## Git workflow

- Branch: `advisor/018-backend-hardening-round2`
- Conventional commits, e.g. `fix(security): cap delivery batch size + allowlist slab-bake image fetches`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Cap the delivery `pull_ids` length

In `delivery-orders/route.ts`, add a `MAX_BATCH` constant (reuse 500 to match the
sibling) and reject arrays longer than it, mirroring the buyback-batch message:

```ts
const MAX_BATCH = 500;
if (pullIds.length > MAX_BATCH) {
  throw new MedusaError(
    MedusaError.Types.INVALID_DATA,
    `Cannot request delivery of more than ${MAX_BATCH} cards at once.`,
  );
}
```

Place it after the existing shape validation.

**Verify**: backend build → exit 0.

### Step 2: Add an egress guard to `fetchBytes`

In `bake-slab.ts`, before the network call in `fetchBytes` (or at each call
site), validate the URL against an allowlist / private-range block. The guard
must:

- allow storefront-relative paths (`/…`) and the configured CDN/file-provider
  host(s) that legitimate `card.image` and `slab_frame_url` values use — read the
  real values first (grep how images are stored / the CDN base URL / the file
  provider config);
- reject RFC-1918, loopback, link-local (169.254.0.0/16), and other
  internal/metadata hosts;
- fail closed (return `null` / skip the fetch, matching how `fetchBytes` already
  signals an unfetchable image with a warn log) rather than throwing the whole
  bake.

Prefer a small reusable `isAllowedImageUrl(url)` helper (parse `new URL`, check
protocol + host against the allowlist, block private IP literals). Mirror the
style of `isPcImageUrl`. Apply it to both the `slab_frame_url` fetch
(`resolveFrameBytes`) and the `card.image` fetch.

**Verify**: backend build → exit 0.

### Step 3: Tests

- Item 1: extend a delivery HTTP spec (`integration-tests/http/delivery-orders.spec.ts`)
  to assert a `pull_ids` array over `MAX_BATCH` is rejected with `INVALID_DATA`.
- Item 2: add a unit test for `isAllowedImageUrl` (or the media unit-test folder)
  asserting: a public CDN URL and a relative `/…` path are allowed; a loopback /
  RFC-1918 / metadata-style host is rejected — in IPv6 forms too: `::1`,
  link-local (`fe80::/10`) and ULA (`fc00::/7`) addresses, and IPv4-mapped IPv6
  (`::ffff:127.0.0.1`, `::ffff:10.0.0.1`), the classic filter-bypass shapes.
  Model after the existing media `__tests__/*.unit.spec.ts`.

**Verify**: `npm run test:integration:http` and `npm run test:unit` → all pass.

## Test plan

- HTTP: over-`MAX_BATCH` delivery request → 400 `INVALID_DATA`.
- Unit: `isAllowedImageUrl` allows legit CDN/relative, rejects private/loopback/
  metadata hosts in both IPv4 and IPv6 (incl. IPv4-mapped `::ffff:…`) forms.
- Verification: both suites pass; backend build exit 0.

## Done criteria

- [ ] `delivery-orders/route.ts` rejects `pull_ids.length > MAX_BATCH`.
- [ ] `bake-slab.ts` fetches only allowlisted hosts / relative paths; private/
      internal hosts are blocked; legit images still bake.
- [ ] Tests for both items exist and pass.
- [ ] Backend build exits 0; integration + unit suites pass.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- You cannot determine the legitimate `card.image` / `slab_frame_url` host set
  from the code/config — STOP and report; a too-strict allowlist would break card
  baking (a visible feature), which is worse than the low-severity SSRF.
- Blocking private IPs requires DNS resolution of hostnames (to catch a hostname
  that resolves to an internal IP) and the runtime has no safe resolver available
  — implement the literal-IP + host-allowlist guard now and note the DNS-rebind
  residual as a follow-up rather than half-implementing it.

## Maintenance notes

- Any new server-side image/URL fetch must go through `isAllowedImageUrl` (or the
  PC-specific allowlist) — that's now the standard for egress from this backend.
- The delivery `MAX_BATCH` should track the vault cap (500); if one changes,
  reconsider the other.
- A reviewer should confirm the allowlist does not reject any URL shape currently
  stored for real cards (test against a sample of live `card.image` values if
  available), and that a bake failure degrades gracefully (warn + skip) rather
  than 500-ing the admin action.
