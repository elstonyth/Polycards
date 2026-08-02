# Plan 063: Keep the Meta Pixel off tokenized pages, add consent withdrawal, fail the OAuth callback closed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a993f34a..HEAD -- src/components/MetaPixel.tsx src/components/CookieConsent.tsx src/lib/consent.ts src/app/auth/google/callback/route.ts src/lib/allowed-hosts.ts src/app/layout.tsx "src/app/(account)/me/page.tsx"`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security / privacy
- **Planned at**: commit `a993f34a`, 2026-08-01

## Why this matters

Three small, related storefront gaps from the delta. (1) The Meta Pixel (#259)
mounts in the root layout, so consenting visitors landing on
`/reset-password?token=…&email=…` race a third-party PageView beacon (which
reports the full URL to Facebook) against the client-side query scrub — a
single-use credential should never depend on script-timing luck. (2) Consent
has no withdrawal path: once accepted, the pixel loads for a year with no
in-product way to revoke. (3) The Google OAuth callback falls back to
`request.url` when the forwarded host isn't allowlisted — `request.url` behind
the DO proxy is the standalone server's bind origin, the exact broken redirect
PR #311 fixed — and the allowlist names `localhost:3000`, a port this repo
never serves (local storefront is `:4000`), so the guard is dead locally.

## Current state

- `src/app/layout.tsx:89` — `<MetaPixel />` mounted unconditionally in the
  root layout (comment at `:86-88` explains why there's no `<noscript>` pixel).
- `src/components/MetaPixel.tsx:14-23` — renders `null` until
  `getConsent() === 'accepted'`; listens on `CONSENT_EVENT`; then injects
  `fbevents.js` and fires `fbq('init', META_PIXEL_ID)` + `fbq('track','PageView')`.
- `src/app/reset-password/ResetPasswordClient.tsx:17-24` — captures
  `token`/`email` from `useSearchParams`, then scrubs:

  ```ts
  useEffect(() => {
    if (!window.location.search) return;
    window.history.replaceState({}, '', window.location.pathname);
  }, []);
  ```

  It sits behind a `<Suspense>` boundary (`src/app/reset-password/page.tsx`),
  so the scrub can run after the pixel's script effect.

- `src/components/CookieConsent.tsx:13` — banner shows only while
  `getConsent() === null`; `setConsent` is called nowhere else in `src/`
  (verified by grep: only `CookieConsent.tsx:18` and tests).
- `src/lib/consent.ts` — `getConsent`/`setConsent` + `CONSENT_EVENT`; cookie
  `max-age` one year.
- `src/app/(account)/me/page.tsx:37-45` — `QUICK_ACCESS` grid (History,
  Orders, Inbox, Download, Address, Support, Settings) — the natural home for
  a "Cookie settings" control is Settings, or a small control on this page.
- `src/app/auth/google/callback/route.ts:23-29`:

  ```ts
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto =
    request.headers.get('x-forwarded-proto') ??
    (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  const origin =
    host && ALLOWED_SELF_HOSTS.has(host) ? `${proto}://${host}` : request.url;
  ```

  and every redirect below builds `new URL(path, origin)`.

- `src/lib/allowed-hosts.ts:12-16`:

  ```ts
  export const ALLOWED_SELF_HOSTS = new Set([
    'polycards.gg',
    'www.polycards.gg',
    'localhost:3000',
  ]);
  ```

  Local serving evidence: `.env.example` `NEXT_PUBLIC_SITE_URL=http://localhost:4000`;
  the standalone server runs on `:4000` (`scripts/serve-standalone.ps1`).
  `googleLoginStart` (`src/lib/actions/auth.ts:241-242`) uses the same set.

- OAuth action tests exist: `src/lib/actions/__tests__/auth.test.ts`
  (covers `googleLoginStart`/`googleCallback` branches with sdk mocks and
  decoy-PII fixtures) — extend, don't fork.

## Commands you will need

| Purpose              | Command         | Expected on success |
| -------------------- | --------------- | ------------------- |
| Unit tests           | `npm test`      | all pass            |
| Typecheck+lint+build | `npm run check` | exit 0              |

## Scope

**In scope**:

- `src/components/MetaPixel.tsx`
- `src/components/CookieConsent.tsx` and/or `src/app/(account)/settings/*` (one small control)
- `src/app/auth/google/callback/route.ts`
- `src/lib/allowed-hosts.ts`
- `src/lib/actions/__tests__/auth.test.ts`, `src/lib/__tests__/consent.test.ts` (extend)

**Out of scope**:

- Moving the reset token into the URL fragment (backend subscriber change —
  noted as follow-up, don't attempt here).
- CSP changes (`src/lib/security/csp.ts`) — the pixel hosts stay allowlisted.
- Any change to when the pixel fires on ordinary pages, or to the banner's
  accept/reject flow.
- `src/lib/actions/auth.ts` `googleLoginStart` behavior (its error return on
  unknown host is already fail-closed).

## Git workflow

- Branch: `advisor/063-privacy-auth-hardening`
- Conventional commits, one per numbered issue.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Exclude the pixel from tokenized routes

In `MetaPixel.tsx`, read `usePathname()` and return `null` when the path is
`/reset-password` (implement as a small `TOKENIZED_ROUTES: string[]` constant
with a comment explaining WHY — credential in the URL — so the next tokenized
route gets added there). Note: `usePathname` in a client component under the
root layout re-renders on navigation, so the pixel resumes on the next page —
that is the intended behavior; once `fbevents.js` has loaded on a prior page,
`window.fbq` persists, so ALSO guard the `PageView` script from re-injecting.
Simplest correct shape: keep the current single-mount `Script` but make the
whole component `null` on tokenized paths BEFORE consent is even checked, and
accept that a visitor who lands directly on `/reset-password` gets no pixel at
all for that session page — that is the point.

**Verify**: `npm run check` → exit 0. `npm test` → passes. Add one test if the
component has a harness; otherwise verify by grep:
`grep -n "reset-password" src/components/MetaPixel.tsx` → match with comment.

### Step 2: Add a consent-withdrawal control

Add a "Cookie settings" affordance reachable without hunting: recommended
placement is the settings page (`src/app/(account)/settings/`) as a small row
with the current state and a "Reject analytics cookies" / "Allow analytics
cookies" toggle-button pair calling `setConsent('rejected' | 'accepted')`.
On REJECT after a prior accept, call `window.location.reload()` — the
already-loaded `fbq` global cannot be un-injected; the reload discards it
(record this in a comment). The accept direction needs no reload
(`MetaPixel` listens on `CONSENT_EVENT`).

**Verify**: `npm test -- consent` → passes including a new case asserting
`setConsent('rejected')` after `'accepted'` overwrites the stored value and
fires `CONSENT_EVENT`. `npm run check` → exit 0.

### Step 3: Fail the OAuth callback closed + fix the allowlist

In `src/app/auth/google/callback/route.ts`, replace the `: request.url`
fallback: when `host` is absent or not in `ALLOWED_SELF_HOSTS`, redirect
RELATIVELY to the existing failure page —
`NextResponse.redirect(new URL('/auth/google/failed?reason=origin', request.nextUrl))`
— never to an absolute origin derived from `request.url`. Keep the happy path
unchanged. In `src/lib/allowed-hosts.ts`, add `localhost:4000` and
`127.0.0.1:4000`; keep or drop `localhost:3000` (drop it — nothing serves it;
say so in the commit body); add a comment that the set must track the domains
in `.do/storefront.app.yaml`.

**Verify**: `npm test -- auth` → passes, including two new cases (Step 4).

### Step 4: Tests

Extend `src/lib/actions/__tests__/auth.test.ts` (follow its existing mock
pattern): (a) callback with an unallowlisted forwarded host redirects to
`/auth/google/failed` with `reason=origin` and does NOT redirect to the bind
origin; (b) callback with `x-forwarded-host: localhost:4000` succeeds. If the
callback route handler isn't directly importable in that harness, put the
origin-resolution logic in a small exported helper (same file as the route)
and test the helper — keep the route thin.

**Verify**: `npm test` → all pass; `npm run check` → exit 0.

## Test plan

- New: consent overwrite case (`consent.test.ts`), two callback-origin cases
  (`auth.test.ts`). Pattern files named in the steps.
- Pixel exclusion is structural (grep + review); no brittle DOM test.

## Done criteria

- [ ] `grep -n "request.url" src/app/auth/google/callback/route.ts` → no fallback-to-request.url in origin resolution (reading it for other purposes is fine; the `: request.url` branch is gone)
- [ ] `grep -n "localhost:4000" src/lib/allowed-hosts.ts` → match
- [ ] `grep -n "reset-password" src/components/MetaPixel.tsx` → match
- [ ] A consent-withdrawal control exists and calls `setConsent`
- [ ] `npm run check` exit 0; `npm test` all pass with the 3 new cases
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `NextResponse.redirect` with a relative URL misbehaves in this Next version
  (test it — if absolute is required, build it from the ALLOWLISTED production
  host, never from `request.url`).
- The settings page structure has no obvious slot for the control and adding
  one would mean redesigning the page — report placement options instead.
- Removing `localhost:3000` breaks a documented flow (grep docs/ and scripts/
  for `:3000` OAuth references first; report hits before dropping).

## Maintenance notes

- Follow-up (deliberately deferred): have the backend password-reset
  subscriber put the token in the URL **fragment** so it never reaches any
  server log or beacon; that kills this class entirely.
- Any new route that carries a credential in its URL must be added to
  `TOKENIZED_ROUTES` — reviewers should ask this question on every new
  tokenized link.
- The go-live runbook's OAuth item (consent screen still in Testing mode) is
  untouched by this plan — operator action.
