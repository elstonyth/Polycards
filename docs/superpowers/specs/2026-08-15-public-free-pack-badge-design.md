# Public free-pack badge — design

Date: 2026-08-15
Status: approved (operator, this session)
Extends: `2026-08-14-free-welcome-pack-design.md` (#438, live in prod)

## Goal

Show the free welcome pack badge on `/slots` to logged-out visitors as a signup
hook. Tapping it opens the auth modal (register-first). Everything else about
the feature — claim flow, hidden-once-claimed, hidden-for-ineligible, the
sell/delivery lock until the first paid open (`hasPaidOpen`) — is already
shipped and stays exactly as is.

## Decisions (operator-confirmed)

1. **Unlock rule unchanged**: sell + delivery on a free pull unlock only after
   opening a paid pack (`hasPaidOpen()` — `source='pack'` pull exists). A
   top-up alone does NOT unlock. Already live; no backend change.
2. **Guest tap → auth modal immediately** on `/slots`. No detail-page detour.
3. **Logged-in but ineligible** (pre-existing account, or already claimed):
   badge hidden, as today. No greyed-out state, no backfill.
4. **Badge only advertises a real pack**: guests see it only while an active
   `free_welcome` pack exists.

## Architecture (approach A — widen the existing route)

### 1. Backend — `GET /store/free-pack` optional auth

- `src/api/middlewares.ts` (the `/store/free-pack` entry, ~line 480):
  `authenticate('customer', ['bearer'], { allowUnauthenticated: true })`.
  `storeReadRateLimit` stays.
- `src/api/store/free-pack/route.ts`: when `req.auth_context?.actor_id` is
  empty → `{ eligible: false, slug: null, image: null, promo: !!(await
  packs.getActiveFreePack()) }`. When authed → today's per-customer answer,
  UNCHANGED (no `promo` field — the client never reads it when authed, and
  adding it would either cost an extra read on the claimed-common-case path
  or lie `false` while a pack exists). `promo` appears only on the
  unauthenticated answer; the schema marks it optional.
- The guest answer leaks only "an active free pack exists" — a catalog fact.
  Response stays uncached (per-customer when authed; keep one code path).

### 2. Storefront data seam — `src/lib/data/free-pack.ts`

Return type becomes a three-state union:

```ts
export type FreePackState =
  | { mode: 'claim'; slug: string }
  | { mode: 'signup' }
  | { mode: 'hidden' };
```

- No cookie token → fetch WITHOUT bearer → `promo === true` → `signup`,
  else `hidden`.
- Token present → fetch as today → `eligible && slug` → `claim`; otherwise
  `hidden` (covers claimed + pre-existing + no-active-pack).
- Any error/non-2xx → `hidden` (unchanged fail-safe; the badge is an
  enhancement and must never take the catalog down).
- `FreePackSchema` (`src/lib/data/schemas.ts`) gains
  `promo: z.boolean().optional()`.

### 3. Badge — `src/components/FreePackBadge.tsx`

Prop changes from `slug: string` to the `FreePackState` union (never called
with `hidden`). Two variants sharing all visuals (image, float animation,
consent gating, reduced-motion, drop shadow, dock position):

- `claim` → today's `<Link href=/slots/<slug>>`.
- `signup` → `<button>` calling `openAuth('signup')` (register-first — the
  audience is new players; the modal has its own login switch).
  `aria-label="Sign up to claim your free welcome pack"`.

After the modal succeeds, `AuthForm` already calls `router.refresh()`
(src/components/AuthForm.tsx:154) → `slots/page.tsx` re-runs server-side →
badge flips to `claim` for a fresh account or disappears for an ineligible
one. Zero new wiring.

### 4. Page + catalog — `src/app/slots/page.tsx`, `CatalogClient.tsx`

- Page passes the state union through (`freePack` prop replaces
  `freePackSlug`).
- `CatalogClient` renders the badge whenever `mode !== 'hidden'` and keeps the
  bottom padding reservation (`pb-56 lg:pb-44`) in both visible modes.

### 5. Ride-along — detail-page CTA label

`src/app/slots/[slug]/PackDetailClient.tsx` (~line 702): free pack + logged
out currently shows "Open Free Pack" while the tap correctly opens the auth
modal. Label becomes "Log in" (match the paid-pack pattern):
`isFreePack ? (customer ? 'Open Free Pack' : 'Log in') : …`.

## Not changing

`hasPaidOpen` unlock, claim workflow, `free_pack_claimed_at` semantics,
catalog exclusion of `free_welcome`, admin single-active/price-0 validation,
eligibility stamping (new registrations only), the buyback/delivery gates and
`FREE_PULL_LOCKED_MESSAGE`.

## Error handling

- Backend: unauthenticated path can only fail on the pack lookup — let the
  framework 500; the storefront seam already maps any failure to `hidden`.
- Storefront: unchanged `try/catch → hidden` around the fetch.

## Testing

- **Backend integration** (`free-pack-route.integration.spec.ts`):
  - unauthenticated GET (no `auth_context`) → 200, `eligible:false`,
    `promo:true` with an active free pack; `promo:false` without.
  - authed answers byte-identical to today (no `promo`).
  - Invalid/expired bearer behavior is framework-owned under
    `allowUnauthenticated` (treated as anonymous → promo answer). Either
    outcome maps to `hidden`/`signup` client-side; verified live with a
    garbage-bearer curl after deploy, not unit-tested.
- **Storefront unit**: schema accepts/omits `promo`; seam maps
  (token × eligible × promo × error) → three states.
- **QA script** (`scripts/qa-free-pack.mjs`): new logged-out step — badge
  visible with `data-testid="free-pack-badge"`, tap opens auth modal,
  register, badge flips to claim link; after claim, badge gone (existing
  step).

## Rollout

Storefront + backend deploy together (route change is
backwards-compatible — old storefront ignores `promo`). No migration. No
admin action beyond the already-pending "create the free_welcome pack".
