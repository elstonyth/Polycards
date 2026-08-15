# Public Free-Pack Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the free welcome pack badge on `/slots` to logged-out visitors; tapping opens the signup modal; everything downstream (claim, lock, hidden-once-claimed) is already live and unchanged.

**Architecture:** Widen `GET /store/free-pack` to optional auth (guest answer carries a single new `promo: boolean` = "an active free_welcome pack exists"). The storefront seam maps (token, response) → a three-state union (`claim` / `signup` / `hidden`); the badge renders a `<Link>` for `claim` and an `openAuth('signup')` `<button>` for `signup`. `AuthForm` already calls `router.refresh()` on success, which re-runs the server page and flips the badge.

**Tech Stack:** Medusa 2 route + `authenticate(..., { allowUnauthenticated: true })`; Next.js App Router server page; zod schema seam; jest `moduleIntegrationTestRunner` (backend), vitest (storefront), Playwright QA script.

**Spec:** `docs/superpowers/specs/2026-08-15-public-free-pack-badge-design.md`

## Global Constraints

- Work in a worktree branch `feat/public-free-pack-badge` (superpowers:using-git-worktrees — consent pre-granted; `npm install` in fresh worktree; copy `.env.local` + backend `.env` in per memory notes). Master is PR-gated.
- TypeScript strict, no `any` (existing test-file `as any` patterns are fine to follow inside tests).
- Backend files use single quotes; a global prettier hook may churn backend edits — if whole-file churn appears, re-edit via a node script through Bash (memory: `global-prettier-hook-churns-backend`).
- Never pipe jest through `tail`/`head` on this machine. Integration specs: PowerShell `$env:NODE_OPTIONS='--experimental-vm-modules'; $env:TEST_TYPE='integration:modules'` against the `pokenic-postgres` Docker container.
- Storefront vitest collects `.test.ts` only.
- Copy rule: the auth-modal signup mode is `'signup'` (openAuth accepts `'login' | 'signup'`).
- The authed `GET /store/free-pack` response must stay byte-identical (no `promo` field) — see spec §1.

## File Structure

| File | Responsibility |
|---|---|
| `backend/packages/api/src/api/store/free-pack/route.ts` | Handler gains the unauthenticated branch (promo answer) |
| `backend/packages/api/src/api/middlewares.ts` | `/store/free-pack` entry gains `{ allowUnauthenticated: true }` |
| `backend/packages/api/src/modules/packs/__tests__/free-pack-route.integration.spec.ts` | New `describe` for the guest answer |
| `src/lib/data/schemas.ts` | `FreePackSchema` gains optional `promo` |
| `src/lib/data/free-pack.ts` | Three-state union + pure `mapFreePackState` + fetch wrapper `getFreePackState` (old `getFreePackEligibility` deleted in Task 3) |
| `src/lib/data/__tests__/free-pack.test.ts` | Unit tests for the pure mapper (new file) |
| `src/lib/data/__tests__/schemas.test.ts` | `promo` acceptance cases |
| `src/components/FreePackBadge.tsx` | Two variants: claim `<Link>` / signup `<button>` |
| `src/app/slots/page.tsx` | Passes the state union |
| `src/app/slots/CatalogClient.tsx` | `freePackSlug` prop → `freePack` union |
| `src/app/slots/[slug]/PackDetailClient.tsx` | CTA label fix (logged-out free pack → "Log in") |
| `scripts/qa-free-pack.mjs` | New logged-out step |

---

### Task 1: Backend — guest promo answer

**Files:**
- Modify: `backend/packages/api/src/api/store/free-pack/route.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (the `/store/free-pack` entry, ~line 477-483)
- Test: `backend/packages/api/src/modules/packs/__tests__/free-pack-route.integration.spec.ts`

**Interfaces:**
- Consumes: `PacksModuleService.getActiveFreePack()` (exists), `listCustomerAccountStates` (exists).
- Produces: unauthenticated `GET /store/free-pack` → `{ eligible: false, slug: null, image: null, promo: boolean }`. Authed response unchanged. Task 2's schema relies on `promo` being boolean-or-absent.

- [ ] **Step 1: Write the failing tests**

In `free-pack-route.integration.spec.ts`, the existing rig exposes `makeReqRes` (builds `req.auth_context` from `opts.customerId`) and seeding helpers. Add a guest request builder beside `makeReqRes` (inside the same `testSuite` scope) and a new `describe`. The guest req has NO `auth_context` key at all — that is what the middleware produces for an anonymous visitor under `allowUnauthenticated`:

```ts
    const guestReqRes = () => {
      const captured: ResCapture = {};
      const res = {
        status(code: number) {
          captured.status = code;
          return this;
        },
        json(body: unknown) {
          captured.body = body;
          return this;
        },
      };
      // No auth_context at all — allowUnauthenticated passes anonymous
      // requests through without one.
      const req = { params: {}, scope: container };
      return { req: req as any, res: res as any, captured };
    };
```

New describe (place after the existing eligibility describes; reuse the suite's existing pack-seeding helper — the file already seeds an active `free_welcome` pack with `FREE_SLUG` for its eligibility cases; mirror that seed call):

```ts
    describe('GET /store/free-pack — unauthenticated promo answer', () => {
      it('answers promo:true (and nothing per-customer) while an active free pack exists', async () => {
        await seedFreePack(); // the suite's existing active free_welcome seeder
        const { req, res, captured } = guestReqRes();
        await freePackGET(req, res);
        expect(captured.body).toEqual({
          eligible: false,
          slug: null,
          image: null,
          promo: true,
        });
      });

      it('answers promo:false when no active free pack exists', async () => {
        // nothing seeded — the runner dropped schema state before this test
        const { req, res, captured } = guestReqRes();
        await freePackGET(req, res);
        expect(captured.body).toEqual({
          eligible: false,
          slug: null,
          image: null,
          promo: false,
        });
      });

      it('authed answer is unchanged — no promo field', async () => {
        await seedFreePack();
        const body = await eligibility(); // existing helper, stamped customer
        expect(body).not.toHaveProperty('promo');
      });
    });
```

NOTE: `seedFreePack` / `eligibility` are the names of this suite's existing helpers — read the file first and use the actual names (the seeder creates the active `free_welcome` pack the current eligibility tests use; `eligibility` wraps `freePackGET` with an authed `makeReqRes`). If the existing authed cases assert exact body shapes with `toEqual`, they already pin "no promo" — keep the explicit `not.toHaveProperty` anyway as the regression tripwire.

- [ ] **Step 2: Run to verify the new tests fail**

PowerShell, from `backend/packages/api`:

```powershell
$env:NODE_OPTIONS='--experimental-vm-modules'; $env:TEST_TYPE='integration:modules'; node node_modules/jest/bin/jest.js src/modules/packs/__tests__/free-pack-route.integration.spec.ts -t 'unauthenticated promo'
```

Expected: FAIL — guest request throws (`Cannot read properties of undefined (reading 'actor_id')`) or wrong body.

- [ ] **Step 3: Implement the route branch**

`backend/packages/api/src/api/store/free-pack/route.ts` — the handler currently reads `req.auth_context.actor_id` unconditionally. Replace the body of `GET` (keep the file's header comment, extend it):

```ts
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // Anonymous visitor (allowUnauthenticated) — answer only the catalog fact
  // "an active free pack exists", so the storefront can show the signup-hook
  // badge. Nothing per-customer leaves on this branch, and `promo` appears
  // ONLY here: the authed answer stays byte-identical to pre-promo clients.
  if (!customerId) {
    const active = await packs.getActiveFreePack();
    res.json({ eligible: false, slug: null, image: null, promo: active != null });
    return;
  }

  const [state] = await packs.listCustomerAccountStates(
    { customer_id: customerId },
    { take: 1 },
  );
  const active =
    state?.free_pack_available_at && !state?.free_pack_claimed_at
      ? await packs.getActiveFreePack()
      : null;

  res.json({
    eligible: active != null,
    slug: active?.slug ?? null,
    image: active?.image ?? null,
  });
}
```

Also update the header comment's AUTH paragraph: the matcher now uses `allowUnauthenticated: true`; anonymous requests get the promo-only branch.

`backend/packages/api/src/api/middlewares.ts` — the existing entry:

```ts
    {
      // Free welcome pack eligibility (GET /store/free-pack) — the ONLY public
      // ...existing comment...
      matcher: '/store/free-pack',
      method: ['GET'],
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
```

becomes (keep the surrounding comment, amend it to say the route now also serves an anonymous promo answer — the per-customer half still requires the verified bearer):

```ts
      middlewares: [
        authenticate('customer', ['bearer'], { allowUnauthenticated: true }),
        storeReadRateLimit,
      ],
```

(Match the entry's exact current shape in the file — copy whatever `method` key it has as-is.)

- [ ] **Step 4: Run the whole spec file to verify green**

```powershell
$env:NODE_OPTIONS='--experimental-vm-modules'; $env:TEST_TYPE='integration:modules'; node node_modules/jest/bin/jest.js src/modules/packs/__tests__/free-pack-route.integration.spec.ts
```

Expected: PASS, including all pre-existing eligibility cases.

- [ ] **Step 5: Typecheck backend**

```powershell
.\node_modules\.bin\tsc --noEmit -p tsconfig.json
```

(from `backend/packages/api`; exit 0)

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/api/store/free-pack/route.ts backend/packages/api/src/api/middlewares.ts backend/packages/api/src/modules/packs/__tests__/free-pack-route.integration.spec.ts
git commit -m "feat(free-pack): anonymous promo answer on GET /store/free-pack"
```

---

### Task 2: Storefront seam — three-state union (additive, old export stays)

**Files:**
- Modify: `src/lib/data/schemas.ts` (FreePackSchema, ~line 255)
- Modify: `src/lib/data/free-pack.ts`
- Create: `src/lib/data/__tests__/free-pack.test.ts`
- Modify: `src/lib/data/__tests__/schemas.test.ts` (FreePackSchema describe, ~line 138)

**Interfaces:**
- Consumes: Task 1's wire shape (`promo` boolean present only on guest answers).
- Produces: `export type FreePackState = { mode: 'claim'; slug: string } | { mode: 'signup' } | { mode: 'hidden' }`; `export function mapFreePackState(hasToken: boolean, parsed: { eligible: boolean; slug: string | null; promo?: boolean } | null): FreePackState`; `export async function getFreePackState(): Promise<FreePackState>`. Task 3 imports `FreePackState` and `getFreePackState`. The old `getFreePackEligibility` export REMAINS in this task (page.tsx still imports it) and dies in Task 3.

- [ ] **Step 1: Write the failing tests**

`src/lib/data/__tests__/free-pack.test.ts` (new file):

```ts
import { describe, expect, it } from 'vitest';
import { mapFreePackState } from '../free-pack';

describe('mapFreePackState — (token, response) → badge state', () => {
  it('guest + promo:true → signup', () => {
    expect(
      mapFreePackState(false, { eligible: false, slug: null, promo: true }),
    ).toEqual({ mode: 'signup' });
  });

  it('guest + promo:false (or absent) → hidden', () => {
    expect(
      mapFreePackState(false, { eligible: false, slug: null, promo: false }),
    ).toEqual({ mode: 'hidden' });
    expect(
      mapFreePackState(false, { eligible: false, slug: null }),
    ).toEqual({ mode: 'hidden' });
  });

  it('authed + eligible with slug → claim', () => {
    expect(
      mapFreePackState(true, { eligible: true, slug: 'free-welcome' }),
    ).toEqual({ mode: 'claim', slug: 'free-welcome' });
  });

  it('authed + ineligible (claimed / pre-existing / no pack) → hidden', () => {
    expect(
      mapFreePackState(true, { eligible: false, slug: null }),
    ).toEqual({ mode: 'hidden' });
  });

  it('eligible without a slug is not an offer → hidden', () => {
    expect(mapFreePackState(true, { eligible: true, slug: null })).toEqual({
      mode: 'hidden',
    });
  });

  it('unparseable response → hidden, both auth states', () => {
    expect(mapFreePackState(true, null)).toEqual({ mode: 'hidden' });
    expect(mapFreePackState(false, null)).toEqual({ mode: 'hidden' });
  });

  it('authed answer never reads promo — a stray promo:true cannot resurrect a spent claim', () => {
    expect(
      mapFreePackState(true, { eligible: false, slug: null, promo: true }),
    ).toEqual({ mode: 'hidden' });
  });
});
```

`src/lib/data/__tests__/schemas.test.ts` — extend the existing `FreePackSchema` describe with one test:

```ts
  it('accepts the anonymous promo answer, promo optional elsewhere', () => {
    expect(
      parseOne(FreePackSchema, {
        eligible: false,
        slug: null,
        image: null,
        promo: true,
      }),
    ).toMatchObject({ eligible: false, promo: true });
    // promo must be a boolean when present
    expect(
      parseOne(FreePackSchema, { eligible: false, slug: null, promo: 'yes' }),
    ).toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure**

```powershell
npx vitest run src/lib/data/__tests__/free-pack.test.ts src/lib/data/__tests__/schemas.test.ts
```

Expected: FAIL — `mapFreePackState` not exported; schema rejects `promo`... note: `FreePackSchema` is `z.looseObject`, so `promo: true` passes through today and `promo: 'yes'` ALSO passes (loose = unknown keys kept, unvalidated). The `'yes'`-rejection test fails until the schema declares the field. That test is the RED.

- [ ] **Step 3: Implement**

`src/lib/data/schemas.ts`:

```ts
export const FreePackSchema = z.looseObject({
  eligible: z.boolean(),
  slug: z.string().nullable(),
  /** Anonymous answers only: "an active free pack exists" (the signup hook). */
  promo: z.boolean().optional(),
});
```

`src/lib/data/free-pack.ts` — add below the existing code (keep `getFreePackEligibility` untouched for now; update the header comment to describe the three-state seam):

```ts
/** Badge state for /slots — the union the page passes to the catalog. */
export type FreePackState =
  | { mode: 'claim'; slug: string }
  | { mode: 'signup' }
  | { mode: 'hidden' };

const HIDDEN: FreePackState = { mode: 'hidden' };

/**
 * Pure mapper, unit-tested: (had a token, parsed answer) → badge state.
 * Guests read ONLY `promo` (the catalog fact); authed customers read ONLY
 * `eligible`+`slug` (the per-customer claim). Neither can leak into the
 * other's branch, so a stray field can never resurrect a spent claim.
 */
export function mapFreePackState(
  hasToken: boolean,
  parsed: { eligible: boolean; slug: string | null; promo?: boolean } | null,
): FreePackState {
  if (!parsed) return HIDDEN;
  if (!hasToken) return parsed.promo ? { mode: 'signup' } : HIDDEN;
  return parsed.eligible && parsed.slug
    ? { mode: 'claim', slug: parsed.slug }
    : HIDDEN;
}

/**
 * Never throws and never caches (same stance as getFreePackEligibility):
 * any failure is `hidden` and the page renders exactly as it does today.
 */
export async function getFreePackState(): Promise<FreePackState> {
  const token = await getAuthToken();
  try {
    const parsed = parseOne(
      FreePackSchema,
      await sdk.client.fetch('/store/free-pack', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      }),
    );
    return mapFreePackState(Boolean(token), parsed);
  } catch (error) {
    logger.error('[free-pack] state read failed:', error);
    return HIDDEN;
  }
}
```

- [ ] **Step 4: Run tests to verify green**

```powershell
npx vitest run src/lib/data/__tests__/free-pack.test.ts src/lib/data/__tests__/schemas.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/data/schemas.ts src/lib/data/free-pack.ts src/lib/data/__tests__/free-pack.test.ts src/lib/data/__tests__/schemas.test.ts
git commit -m "feat(free-pack): three-state badge seam (claim/signup/hidden) + promo schema"
```

---

### Task 3: UI — badge variants, catalog prop, CTA label

**Files:**
- Modify: `src/components/FreePackBadge.tsx`
- Modify: `src/app/slots/CatalogClient.tsx` (~lines 226-264)
- Modify: `src/app/slots/page.tsx`
- Modify: `src/app/slots/[slug]/PackDetailClient.tsx` (~line 702)
- Modify: `src/lib/data/free-pack.ts` (delete `getFreePackEligibility` + its `NOT_ELIGIBLE`/`FreePackEligibility` leftovers)

**Interfaces:**
- Consumes: `FreePackState`, `getFreePackState` from Task 2; `openAuth` from `src/components/AuthButton.tsx` (`openAuth(mode: 'login' | 'signup')`, dispatches the global auth-modal event).
- Produces: `FreePackBadge` prop is now `state: Exclude<FreePackState, { mode: 'hidden' }>`; `CatalogClient` prop `freePack?: Exclude<FreePackState, { mode: 'hidden' }> | null` (replaces `freePackSlug`). No other consumers exist (grep `FreePackBadge`/`freePackSlug` — only CatalogClient and slots/page.tsx).

- [ ] **Step 1: Rewrite FreePackBadge with two variants**

Full new body (keeps consent gating, reduced-motion, float, dock position, testid; header comment updated to describe both variants):

```tsx
'use client';

import Link from 'next/link';
import Image from 'next/image';
import { openAuth } from '@/components/AuthButton';
import type { FreePackState } from '@/lib/data/free-pack';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useConsent } from '@/lib/use-consent';
import { cn } from '@/lib/utils';

/**
 * The free welcome pack's ONLY entry point — a floating badge on /slots.
 *
 * Two variants sharing one visual:
 *  - `claim`  — an eligible customer; links to the (uncataloged) pack page.
 *  - `signup` — a logged-out visitor while an active free pack exists; opens
 *    the auth modal in register mode. AuthForm calls router.refresh() on
 *    success, so the server page re-answers and this badge flips to `claim`
 *    (fresh account) or disappears (ineligible account).
 *
 * Docked above the 5-tab bar (TabBar is `h-16` + safe-area, `lg:hidden`), so it
 * sits on the same rail as the pack page's mobile buy dock and drops to a plain
 * inset once the tab bar is gone at lg.
 */
export default function FreePackBadge({
  state,
}: {
  state: Exclude<FreePackState, { mode: 'hidden' }>;
}) {
  const reduced = usePrefersReducedMotion();
  // While cookie consent is undecided the banner (z-50) docks on exactly this
  // rail and swallows the badge's taps — the same collision the vault action bar
  // hits (see VaultClient). Hold the badge until the visitor answers;
  // CONSENT_EVENT re-renders it the moment they do.
  const consent = useConsent();
  if (consent === null) return null;

  const shellCls =
    'fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-40 block transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white lg:bottom-6';
  const art = (
    <Image
      src="/images/polycards/free-pack-badge.webp"
      alt="Free welcome pack"
      width={112}
      height={146}
      // Decorative-adjacent chrome, but it IS the control's only visible
      // content, so it keeps a real alt; priority is deliberately off (it must
      // never compete with the catalog art for bandwidth).
      className={cn(
        'h-auto w-[112px] drop-shadow-[0_8px_24px_rgba(0,0,0,0.55)]',
        // Gentle idle bob — reuses globals.css's `slabFloat` (±8px) rather
        // than minting a second identical keyframe. No fill-mode (repo rule:
        // never `both`), and `infinite`, so settle-then-read QA must filter it
        // out. Doubly reduced-motion safe: the `motion-safe:` variant drops it
        // in CSS and `reduced` drops it in JS.
        !reduced && 'motion-safe:animate-[slabFloat_3s_ease-in-out_infinite]',
      )}
    />
  );

  if (state.mode === 'signup') {
    return (
      <button
        type="button"
        onClick={() => openAuth('signup')}
        data-testid="free-pack-badge"
        aria-label="Sign up to claim your free welcome pack"
        className={shellCls}
      >
        {art}
      </button>
    );
  }
  return (
    <Link
      href={`/slots/${encodeURIComponent(state.slug)}`}
      data-testid="free-pack-badge"
      aria-label="Claim your free welcome pack"
      className={shellCls}
    >
      {art}
    </Link>
  );
}
```

- [ ] **Step 2: CatalogClient prop swap**

In `src/app/slots/CatalogClient.tsx`: add `import type { FreePackState } from '@/lib/data/free-pack';`, then replace the `freePackSlug` prop (declaration, JSDoc, both use sites):

```tsx
export default function CatalogClient({
  categories,
  initialCategory,
  freePack = null,
}: {
  categories: PackCategory[];
  initialCategory: string;
  /** Visible badge state, or null. `claim` only while this customer's one-time
   *  welcome claim is unspent; `signup` for logged-out visitors while an
   *  active free pack exists. The badge is the free pack's only entry point
   *  (it is not in `categories`). */
  freePack?: Exclude<FreePackState, { mode: 'hidden' }> | null;
}) {
```

Padding + render sites (same truthiness pattern as before):

```tsx
        freePack && 'pb-56 lg:pb-44',
```

```tsx
      {freePack && <FreePackBadge state={freePack} />}
```

- [ ] **Step 3: Page passes the union; delete the old seam export**

`src/app/slots/page.tsx` — swap the import and call:

```tsx
import { getFreePackState } from '@/lib/data/free-pack';
```

```tsx
  const [{ category }, categories, freePack] = await Promise.all([
    searchParams,
    getPackCategories(),
    // Per-visitor and never cached; degrades to "hidden" on any failure, so it
    // can't take the catalog down with it.
    getFreePackState(),
  ]);
```

```tsx
    <CatalogClient
      categories={categories}
      initialCategory={initialCategory}
      // The free pack is absent from `categories` by design (the backend hides
      // its category) — the badge is its only entry point.
      freePack={freePack.mode === 'hidden' ? null : freePack}
    />
```

Then in `src/lib/data/free-pack.ts` delete `getFreePackEligibility`, `FreePackEligibility`, and `NOT_ELIGIBLE` (grep first: `getFreePackEligibility` must have zero remaining importers).

- [ ] **Step 4: PackDetailClient CTA label**

`src/app/slots/[slug]/PackDetailClient.tsx` ~line 702 — current:

```tsx
            {isFreePack ? 'Open Free Pack' : customer ? 'Open Pack' : 'Log in'}
```

becomes (a logged-out tap opens the auth modal on BOTH pack kinds — `handleGoToReel` checks `!customer` first — so the label must match the action):

```tsx
            {customer ? (isFreePack ? 'Open Free Pack' : 'Open Pack') : 'Log in'}
```

- [ ] **Step 5: Typecheck + full storefront unit suite**

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
npx vitest run
```

Expected: both green (the PostToolUse hook also typechecks each edit).

- [ ] **Step 6: Commit**

```bash
git add src/components/FreePackBadge.tsx src/app/slots/CatalogClient.tsx src/app/slots/page.tsx "src/app/slots/[slug]/PackDetailClient.tsx" src/lib/data/free-pack.ts
git commit -m "feat(free-pack): signup-hook badge for logged-out visitors on /slots"
```

---

### Task 4: QA script logged-out step + local end-to-end verification

**Files:**
- Modify: `scripts/qa-free-pack.mjs`
- Docs: `docs/superpowers/specs/2026-08-15-public-free-pack-badge-design.md` + this plan ride along in the same PR

**Interfaces:**
- Consumes: `data-testid="free-pack-badge"` (both variants, Task 3); the auth modal opened by `openAuth('signup')` (AuthForm renders an email input inside a dialog).

- [ ] **Step 1: Add the logged-out step to qa-free-pack.mjs**

The script creates its own active `free_welcome` pack, then walks the claim loop in a logged-in context. Insert a guest check BEFORE the registration/login section — a fresh incognito context, no auth cookie:

```js
  // ── Guest: the badge is the signup hook ───────────────────────────────────
  {
    const guest = await browser.newContext();
    const gp = await guest.newPage();
    await gp.goto(`${BASE}/slots`, { waitUntil: 'networkidle' });
    // Cookie banner docks on the badge rail; the badge holds until answered.
    const reject = gp.getByRole('button', { name: /reject|decline/i });
    if (await reject.isVisible().catch(() => false)) await reject.click();
    const badge = gp.getByTestId('free-pack-badge');
    if (!(await badge.isVisible().catch(() => false))) {
      fail('guest badge not visible on /slots while an active free pack exists');
    } else {
      ok('guest badge visible on /slots');
      await shot(gp, 'guest-badge');
      await badge.click();
      // openAuth('signup') → auth modal with an email field.
      const email = gp.locator('input[type="email"]');
      if (!(await email.first().isVisible({ timeout: 4000 }).catch(() => false))) {
        fail('tapping the guest badge did not open the auth modal');
      } else {
        ok('guest badge tap opens the auth modal (signup)');
        await shot(gp, 'guest-badge-auth-modal');
      }
    }
    await guest.close();
  }
```

Match the script's existing locator idioms when editing (it already handles the cookie banner for the member context — reuse its exact reject-button selector if one exists rather than the regex above).

- [ ] **Step 2: Build + serve + run the full QA script locally**

Per the worktree serving memory (worktree serves on 4100; copy `.env.local` + `.env.e2e` in first; backend from the worktree needs `backend/packages/api/.env`):

```powershell
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4100   # background
# backend: corepack yarn dev from backend/packages/api (worktree), :9000
$env:PW_BASE='http://localhost:4100'; $env:QA_ADMIN_EMAIL='<local admin>'; $env:QA_ADMIN_PASSWORD='<local admin pw>'; node scripts/qa-free-pack.mjs
```

Expected: every existing `✓` plus the two new guest checks. Read the two new screenshots back (`docs/research/qa-free-pack-guest-badge.png`, `qa-free-pack-guest-badge-auth-modal.png`) with the Read tool — the badge must sit clear of the tab bar and the modal must be the signup form.

- [ ] **Step 3: Guest promo curl against the local backend**

```bash
curl -s http://localhost:9000/store/free-pack -H "x-publishable-api-key: <local pk>"
```

Expected: `{"eligible":false,"slug":null,"image":null,"promo":true}` (the QA pack is active). Also probe a garbage bearer — expected: same promo answer OR 401; either maps to a hidden/signup badge, just record which.

- [ ] **Step 4: Commit**

```bash
git add scripts/qa-free-pack.mjs docs/superpowers/specs/2026-08-15-public-free-pack-badge-design.md docs/superpowers/plans/2026-08-15-public-free-pack-badge.md
git commit -m "test(free-pack): guest signup-hook badge QA step + design docs"
```

---

### Task 5: PR, CI, merge, prod verify

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/public-free-pack-badge
gh pr create --title "feat(free-pack): show the free-pack badge to logged-out visitors as a signup hook" --body "Implements docs/superpowers/specs/2026-08-15-public-free-pack-badge-design.md — guest promo answer on GET /store/free-pack (allowUnauthenticated), three-state badge seam, signup-variant badge, CTA label fix. Unlock rule (hasPaidOpen) unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 2: Gate on per-check status, never `gh run watch`**

```bash
gh pr checks <num> --watch
```

Memory `gh-run-watch-false-green`: verify every individual check green. TRUNCATE-deadlock flake in integration-http → rerun `--failed`.

- [ ] **Step 3: Merge (operator permission), watch the deploy**

Merge path per memory: update-branch if stale, then plain `--squash` (needs operator go-ahead). Then watch both DO apps; the backend clone-flake (`stream ID 7; CANCEL`) may need a retrigger.

```bash
doctl apps list-deployments 7fd66ea2-0105-420b-87eb-8a4606262561 --format ID,Phase,Created | head -3
doctl apps list-deployments 4bf179e0-70a8-4fd7-bd25-9be43e9d0319 --format ID,Phase,Created | head -3
```

- [ ] **Step 4: Prod verification**

```bash
# Guest promo answer (no bearer):
curl -s https://polycards-backend-gce6p.ondigitalocean.app/store/free-pack -H "x-publishable-api-key: pk_86273b7c12ca5b2fd838bf1c1cf6427dbb6ef41c723d8af1efa20db183517534"
```

Expected: 200, `promo:false` until the operator creates the free pack (or `promo:true` after). NOT 401. Then a headless-browser check of https://polycards.gg/slots as a guest: badge present iff `promo:true`. Report both to the operator.

---

## Self-Review (done at write time)

- **Spec coverage:** §1 route+middleware → Task 1; §2 seam+schema → Task 2; §3 badge, §4 page/catalog, §5 CTA → Task 3; testing section → Tasks 1/2/4; rollout → Task 5. No gaps.
- **Placeholders:** none — all code inline; the two "read the file first" notes (seeder/eligibility helper names, cookie-reject selector) are deliberate adapt-to-actual-name instructions with the intended semantics stated, not TBDs.
- **Type consistency:** `FreePackState` union spelled identically in Tasks 2/3; `mapFreePackState(hasToken, parsed)` signature matches its tests; badge prop `state: Exclude<FreePackState, { mode: 'hidden' }>` matches CatalogClient's `freePack` prop type; `promo` optional-boolean consistent across route, schema, mapper.
