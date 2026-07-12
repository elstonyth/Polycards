# Plan 029: from-PriceCharting route — cap the money fields and resolve the pixel id at add-time

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat dbce0561..HEAD -- backend/packages/api/src/api/admin/products/from-pricecharting/route.ts backend/packages/api/integration-tests/http/product-from-pc.spec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (additive validation; rejects only values the admin UI never produces)
- **Depends on**: none
- **Category**: security / bug
- **Planned at**: commit `dbce0561`, 2026-07-13

## Why this matters

`POST /admin/products/from-pricecharting` (PR #135) validates its money
fields with a local `requireNonNegativeNumber` that has **no upper bound**,
while the sibling card register/edit path caps `market_value` at
`MAX_MARKET_VALUE_USD` (100,000 — "the buyback money lever — cap it like the
FX seam caps rates"). The from-PC `market_value` becomes `metadata.fmv` and
drives the listing price (FMV × FX), so a direct admin API client — or a
fat-fingered or compromised operator token — can mint a marketplace listing
at an arbitrary price with no server-side ceiling. Same class of gap plans
004/015 closed twice before on other admin money inputs; this route shipped
after those plans and missed the convention. (The gacha buyback economy is
NOT exposed: card registration re-validates through the capped path.)

Second gap in the same route: PR #135's stated guarantee is "a from-PC
product must carry a valid `pixel_pokemon_id` … all clients covered", but
the guard checks only non-emptiness (type/trim). A non-empty-but-bogus id
posted directly to the route passes, then at card registration the
_inherited_ staged id deliberately degrades to name-derivation (that
fallback exists for the legitimate "library entry deleted later" case) —
reproducing the exact spriteless card #135 set out to prevent. The right
fix is to resolve the id **at add-time**, when the entry is guaranteed to
exist, without touching create-card's deliberate later-deleted-entry
degradation.

## Current state

Files:

- `backend/packages/api/src/api/admin/products/from-pricecharting/route.ts`
  — the route; local validators at ~lines 36-64; field extraction at
  ~95-130.
- `backend/packages/api/src/api/admin/cards/validate.ts` — the capped
  sibling (exemplar). `reqMarketValue` (~lines 49-56) does
  `if (v > MAX_MARKET_VALUE_USD) bad(...)`; `MAX_MARKET_VALUE_USD` is
  imported from `'../../../modules/packs/sync-market-prices'` (defined
  there, value 100_000). `optPixelPokemonId` (~lines 66-74) does type/trim
  only — by design (tri-state form round-trip helper); do not change it.
- `backend/packages/api/src/modules/packs/card-pixel-pokemon.ts:41` —
  `export async function resolvePixelPokemonPatch(packs, id)`: resolves a
  PixelPokemon library id; throws `MedusaError` `NOT_FOUND` when the id
  doesn't exist (this is what create-card's explicit path uses to hard-fail
  a bad pick).
- `backend/packages/api/src/workflows/steps/create-card.ts:~145-176` — the
  inherited-id degradation branch (catches NOT_FOUND → registers unlinked
  with a warn log). **Out of scope** — its behavior is correct for its case.
- `backend/packages/api/integration-tests/http/product-from-pc.spec.ts` —
  the route's HTTP spec; PR #135 already added one rejection case (missing
  pixel id) to model new cases on.

Route excerpts as of `dbce0561`:

```ts
const requireNonNegativeNumber = (value: unknown, field: string): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be a non-negative number.`,
    );
  }
  return n;
};
```

```ts
const market_value = requireNonNegativeNumber(
  body.market_value,
  'market_value',
);
// ...
const price =
  body.price === null || body.price === undefined
    ? null
    : requireNonNegativeNumber(body.price, 'price');
// ...
const stock =
  body.stock === undefined ? 0 : requireNonNegativeInteger(body.stock, 'stock');
// ...
const pixel_pokemon_id =
  optPixelPokemonId(body as Record<string, unknown>) ?? null;
if (pixel_pokemon_id === null) {
  throw new MedusaError(
    MedusaError.Types.INVALID_DATA,
    "'pixel_pokemon_id' is required — link a PixelPokemon library entry or upload a custom sprite.",
  );
}
```

Convention to match: `MedusaError.Types.INVALID_DATA` with a
field-in-quotes message, like the excerpts above and `validate.ts`.

## Commands you will need

| Purpose        | Command (working dir)                                                                               | Expected on success |
| -------------- | --------------------------------------------------------------------------------------------------- | ------------------- |
| Start DB/Redis | `docker start pokenic-postgres pokenic-redis`                                                       | both names printed  |
| Install + deps | `corepack yarn install --immutable && corepack yarn build --filter="@acme/api^..."` (in `backend/`) | exit 0              |
| Typecheck      | `corepack yarn check-types` (in `backend/`)                                                         | exit 0              |
| This spec only | `corepack yarn test:integration:http product-from-pc.spec` (in `backend/packages/api`, Git Bash)    | all pass            |

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/api/admin/products/from-pricecharting/route.ts`
- `backend/packages/api/integration-tests/http/product-from-pc.spec.ts`
- `plans/README.md` — status row

**Out of scope** (do NOT touch):

- `backend/packages/api/src/api/admin/cards/validate.ts` — `optPixelPokemonId`'s
  tri-state semantics serve the card-edit form round-trip; hardening it
  would break "picker untouched = leave link as-is".
- `backend/packages/api/src/workflows/steps/create-card.ts` — the inherited-id
  degradation is deliberate (deleted-entry case, PR #116).
- `create-product-from-pricecharting.ts` workflow — validation belongs at
  the route trust boundary, matching #135's own design note.
- The admin SPA form (`backend/apps/admin/src/routes/products/from-pricecharting/page.tsx`)
  — it already prevents these inputs client-side; this plan is the server
  backstop.

## Git workflow

- Branch: `advisor/029-from-pc-bounds`
- Conventional commit, e.g. `fix(admin): cap from-PC money fields; resolve pixel id at add-time`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Cap the money fields

In the route, import the shared ceiling (path depth: this file is 4 levels
under `src/api/`, so `'../../../../modules/packs/sync-market-prices'` —
confirm by compiling):

```ts
import { MAX_MARKET_VALUE_USD } from '../../../../modules/packs/sync-market-prices';
```

After the existing `market_value` extraction, reject values above the cap
with the sibling's message shape: `'market_value' must be at most 100000.`
(interpolate the constant, don't hardcode). Apply the same cap to `price`
when non-null (it is a USD money field on the same listing). Give `stock`
a sane ceiling with a named local constant and a one-line comment:

```ts
// Server backstop only — the admin UI never sends more; matches the money-cap
// posture of cards/validate.ts (plans 004/015 lineage).
const MAX_FROM_PC_STOCK = 10_000;
```

**Verify**: `corepack yarn check-types` → exit 0 (proves the import path).

### Step 2: Resolve the pixel id at add-time

After the existing `pixel_pokemon_id === null` rejection, resolve it:

```ts
try {
  await resolvePixelPokemonPatch(packs, pixel_pokemon_id);
} catch (e) {
  if (e instanceof MedusaError && e.type === MedusaError.Types.NOT_FOUND) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "'pixel_pokemon_id' does not match a PixelPokemon library entry.",
    );
  }
  throw e;
}
```

Import `resolvePixelPokemonPatch` from
`'../../../../modules/packs/card-pixel-pokemon'`. `packs` — the route
already resolves the packs module service (or resolve it the way the
sibling admin routes do: `req.scope.resolve(PACKS_MODULE)`); reuse whatever
handle the route already has before adding a new resolve.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 3: Extend the HTTP spec

In `product-from-pc.spec.ts`, model on the existing missing-pixel-id
rejection case (added by #135) and add:

1. `market_value` above the cap (e.g. `200_000`) → 400, message contains
   `'market_value' must be at most`.
2. `price` above the cap → 400.
3. `stock` above `MAX_FROM_PC_STOCK` → 400.
4. Well-formed but nonexistent `pixel_pokemon_id` (e.g. `'pp_does_not_exist'`)
   → 400, message contains `does not match a PixelPokemon library entry`.
5. Confirm the happy path still passes: the spec's existing success case
   (which stages a real pixel entry) must remain green — it proves Step 2
   accepts valid ids.

**Verify**: `corepack yarn test:integration:http product-from-pc.spec` →
all pass, including 4 new rejection cases. Run twice.

## Test plan

- New cases per Step 3 in `product-from-pc.spec.ts` (pattern: the file's own
  existing rejection case).
- Also run `corepack yarn test:integration:http card-inherits-pc.spec` once
  — it exercises the staged-pixel inheritance path downstream of this route
  and must stay green (proves Step 2 didn't break the legit flow).

## Done criteria

Machine-checkable; ALL must hold:

- [ ] `grep -n "MAX_MARKET_VALUE_USD" backend/packages/api/src/api/admin/products/from-pricecharting/route.ts` → ≥2 matches (import + use)
- [ ] `grep -n "resolvePixelPokemonPatch" backend/packages/api/src/api/admin/products/from-pricecharting/route.ts` → ≥2 matches (import + call)
- [ ] `corepack yarn check-types` exits 0
- [ ] `corepack yarn test:integration:http product-from-pc.spec` → green incl. 4 new cases, twice
- [ ] `corepack yarn test:integration:http card-inherits-pc.spec` → green
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `resolvePixelPokemonPatch`'s signature doesn't accept the packs service
  handle the route has (e.g. it needs a different module type) — report the
  actual signature rather than force-casting.
- The route already resolves/validates the pixel id (drift since
  `dbce0561`).
- `card-inherits-pc.spec` goes red after Step 2 — the add-time resolution
  must not affect inheritance; if it does, the staging flow changed.
- The cap breaks the spec's existing happy-path fixture (its FMV would have
  to exceed 100k — if so the fixture is the problem; report, don't raise
  the cap).

## Maintenance notes

- This is the third instance of the "guard added on one admin money path,
  missed on a sibling" class (plans 004, 015, now 029). The round-2 index
  already recommends a shared validation module if a fourth appears —
  reviewers should hold new admin money routes to `MAX_MARKET_VALUE_USD`
  from day one.
- If a bulk from-PC import route ever lands, it must reuse these exact
  caps and the add-time pixel resolution.
- Reviewer scrutiny: the import path depth (4× `../`), and that
  `optPixelPokemonId` / `create-card.ts` were NOT modified.
