# Design — Admin dashboard React Query seam (Candidate B)

**Date:** 2026-06-16
**Scope:** `backend/apps/admin` (the Mercur standalone Vite admin app)
**Origin:** Candidate B from the 2026-06-16 architecture review (`improve-codebase-architecture`). Candidate C (`@acme/odds-math`) already shipped (PR #4/#5).

## Problem

Every custom admin route page hand-rolls the same resource-loading state machine:

```tsx
const [data, setData] = useState<T | null>(null);
const [error, setError] = useState(false);
useEffect(() => {
  let active = true;
  fetchFn().then(r => active && setData(r)).catch(() => active && setError(true));
  return () => { active = false; };
}, [deps]);
// loading = data === null, error = error, empty = data-specific
```

Plus ad-hoc `reload()` functions after mutations and per-action `saving`/`uploading` booleans. This is duplicated across 5 mount-load pages + the register modal, and one copy is buggy:

- **`packs/[slug]/page.tsx` `reloadOdds()`** runs `setRows`/`setPackTitle`/`setPackStatus` after an `await` with **no mount guard** (unlike the mount effect). If the component unmounts mid-refetch, state is set on an unmounted tree.

`@tanstack/react-query@5.64.2` is already a workspace dependency, and the Medusa/Mercur dashboard already mounts a `QueryClientProvider` (see Constraint).

## Goal

Replace the hand-rolled pattern with a centralized React Query seam. Behavior-preserving. Eliminates the `reloadOdds` bug class for free. No new provider, no new transport.

## Resolved constraint — QueryClientProvider already exists

`@medusajs/dashboard` mounts `<QueryClientProvider client={queryClient}>` in `providers/providers.tsx`; custom file-based routes render inside it as children. The shared `queryClient` is configured `{ refetchOnWindowFocus: false, staleTime: 90000, retry: 1 }` (`lib/query-client.ts`). React Query 5.64.2 is pinned in `backend/package.json` to match the dashboard's copy, so it dedupes to a single instance and shares context.

**Decision: do NOT add a provider.** Use `useQuery` / `useMutation` / `useQueryClient` against the existing context. Inherit the dashboard's default query options.

## Architecture — the seam

### New module: `backend/apps/admin/src/lib/queries.ts`

Owns three things so pages stop hand-rolling them: **query keys**, **display query hooks**, **mutation hooks** (invalidation lives here). The `mutationFn`s reuse the existing API functions in `lib/packs-api.ts` and `lib/admin-rest.ts` — this module does not reimplement transport.

**i18n toasts stay in pages.** Mutation hooks own only the `mutationFn` + `onSuccess` cache invalidation. Pages call `mutateAsync` in a try/catch (matching today's imperative style) to drive their own toast copy, modal-close, and form-reset. Page-level success runs after the hook's invalidation fires.

#### Query-key factory

```ts
export const qk = {
  packs: ['admin', 'packs'] as const,
  pack: (slug: string) => ['admin', 'pack', slug] as const,
  packOdds: (slug: string) => ['admin', 'pack', slug, 'odds'] as const,
  cards: ['admin', 'cards'] as const,
  pulls: ['admin', 'pulls'] as const,
  economy: ['admin', 'economy'] as const,
  eligibleProducts: ['admin', 'eligible-products'] as const,
  customerGacha: (id: string) => ['admin', 'customer', id, 'gacha'] as const,
};
```

#### Display hooks

| Hook | queryFn | Notes |
|---|---|---|
| `usePacks()` | `packsApi.admin.packs.query()` → `.packs` | |
| `useCards()` | `packsApi.admin.cards.query()` → `.cards` | shared by cards page **and** `[slug]` pool picker → one cache |
| `usePulls()` | `packsApi.admin.pulls.query()` | |
| `useEconomy()` | `getEconomyReport()` | |
| `usePackOdds(slug)` | `packsApi.admin.packs.$slug.odds.query({ $slug: slug })` | `enabled: !!slug` |
| `useEligibleProducts(enabled)` | `listEligibleProducts()` | `staleTime: 0` so each modal-open refetches fresh (preserves current "reload on open") |
| `useCustomerGacha(id \| null)` | `getCustomerGacha(id)` | `enabled: !!id` |

Loading → `isPending`, error → `isError`. Empty stays data-specific (e.g. `cards.length === 0`).

#### Mutation hooks (invalidation target in parens)

- `useUpdateCard` (cards), `useDeleteCard` (cards), `useRegisterCard` (cards + eligibleProducts)
- `useCreatePack` (packs), `useUpdatePack` (packs), `useDeletePack` (packs)
- `useSaveOdds` (— see tightening), `useSaveMembers` (packOdds(slug))
- `useAdjustCredits` (customerGacha(id))
- `useUploadImage` — plain mutation, no list to invalidate (`uploading` → `isPending`)

## Per-page changes

| Page | Change |
|---|---|
| `routes/pulls/page.tsx` | drop effect+state → `usePulls()` |
| `routes/economy/page.tsx` | drop effect+state → `useEconomy()` |
| `routes/cards/page.tsx` | `useCards()`; delete `reload()` (mutations invalidate); edit-save + delete → `useUpdateCard`/`useDeleteCard`; image upload → `useUploadImage` |
| `routes/packs/page.tsx` | `usePacks()`; delete `reload()`; create/update/delete → mutation hooks; upload → `useUploadImage` |
| `routes/packs/[slug]/page.tsx` | `usePackOdds(slug)` snapshot + local editable `rows` seeded via effect; **delete `reloadOdds`**; pool picker uses `useCards()`; `packTitle`/`packStatus` derived from `data.pack` (drop the two `useState`s) |
| `routes/cards/RegisterCardModal.tsx` | `useEligibleProducts(open)`; keep the local form-reset effect; register → `useRegisterCard` |
| `routes/support/page.tsx` | **partial**: `useCustomerGacha(selectedId)` for the view + `useAdjustCredits` (removes the manual re-fetch at line 108). Search stays imperative (one-shot action, not a cached resource). `selectedId` replaces the imperative `view` load. |

## The odds-editor edit buffer (the delicate part)

`rows` in `packs/[slug]/page.tsx` is **both** the server snapshot **and** an edit buffer (`pctInput` strings, `locked` toggles). Plan:

```ts
const { data, isPending, isError } = usePackOdds(slug);
const [rows, setRows] = useState<EditRow[] | null>(null);
useEffect(() => { if (data) setRows(mapOddsToRows(data.odds)); }, [data]);
const packTitle = data?.pack.title ?? slug;
const packStatus = data?.pack.status ?? '';
```

### Win-rate lock correctness (verified safe)

- **`locked` is server-persisted**, not derived: `pack_odds.locked` is a real column (`models/pack-odds.ts`). GET returns `o.locked` per row (`odds/route.ts`); POST round-trips it through `savePackOddsWorkflow`. So any refetch returns the operator's saved locks exactly.
- **No refetch happens during editing.** Lock toggles and win-rate typing mutate only local `rows`. The `usePackOdds` query never refires while editing (`staleTime 90s`, no refetch-on-focus, no invalidation from local edits). So the seeding effect stays dormant → in-progress lock edits are never clobbered.
- **Tightening (from review): `saveOdds` keeps the response-patch and does NOT invalidate.** It updates `rows` in place from the POST response exactly as today → the lock-save path is byte-identical to current behavior. `useSaveOdds` therefore has no `onSuccess` invalidation; the page keeps its existing row-patch logic.
- **Only `saveMembers` invalidates `packOdds(slug)`** → the seeding effect reseeds rows from the server. This matches today's `reloadOdds` (which also full-resets rows from a GET after a membership change). The only difference from today is that the unguarded manual refetch becomes a React-Query-managed invalidation → the bug is gone.

Net: the only behavioral change is `reloadOdds` (buggy, post-membership-only) → an invalidation. Win-rate/lock editing and saving are unchanged.

## Out of scope (do not touch)

- `usd` / `fmtPct` / `timeAgo` duplication = **Candidate D**, separate PR.
- Converting customer search to a query = declined (kept imperative).
- No provider added. No ADR. No transport/`packs-api` changes.

## Testing & verification

- **Enforced gate:** backend typecheck (PostToolUse + Stop hooks) + `corepack yarn build` (turbo; builds `@acme/odds-math` dist first via `^build`) + admin lint.
- **Unit:** thin test for the `qk` key factory + `mapOddsToRows` mapper (pure functions).
- **Manual/e2e:** admin smoke needs 4 services (storefront/backend/admin + infra). Run if services are up; otherwise note as a follow-up. Optionally add a win-rate lock round-trip assertion to the existing `odds-100%-determinism` e2e.

## Risks

- **Seeding-effect clobber** — mitigated: only intentional invalidations refetch (config + only `saveMembers` invalidates packOdds).
- **react-query instance mismatch** — mitigated: pinned to dashboard's 5.64.2, dedupes; provider confirmed present.
- **Behavioral drift on save** — mitigated by the tightening (saveOdds unchanged).

## Branch / workflow

Branch in the main checkout (deps already present → far cheaper than a worktree's full `corepack yarn install`, per handoff). PR for CodeRabbit review (run CLI from the real checkout, not a worktree).
