# The storefront reads store response shapes from the backend

ADR 0017 did this for the admin. The storefront had the same problem: each store
response was declared three times, as a zod `looseObject` subset in
`src/lib/data/schemas/`, a hand-written `Backend*` interface, and an
`as unknown as` cast between them. Nothing checked the interface against the
route, so a backend rename only showed up on the page.

Now the vault, delivery orders, pack catalog and detail, recent pulls,
leaderboard and public profile routes each have a `types.ts` beside the route,
and both sides are checked against it.

- **The shape lives in `backend/packages/api/src/api/store/<route>/types.ts`**,
  types only. The handler declares `res: MedusaResponse<Shape>`, and any cache
  or compute that feeds `res.json` carries the same type, so the backend fails
  its typecheck if it sends something else. Dates go out through
  `api/utils/wire-date.ts`, which sends the same bytes `res.json` already did.
- **These files import nothing.** The storefront's CI job and its Docker build
  install only the root packages, so a store `types.ts` that reached
  `@medusajs/*` would pass locally and fail there.
  `.github/scripts/deploy-targets.mjs --test` fails if one does.
- **The storefront imports them as `@acme/api/store/<route>`**, a path in the
  root `tsconfig.json` (the api package's `exports` has the same `./store/*`
  entry, types only). Next resolves tsconfig paths at runtime too, so ESLint
  allows only `import type` from `@acme/api/*`: no backend code enters the
  bundle.
- **The zod guards stay.** The storefront deploys ahead of the backend, so a
  field added recently may be absent. The guards' `.catch()` and `.optional()`
  handle that at runtime, and `MaybeAbsent` (`src/lib/store-wire.ts`) marks the
  same fields optional in the type, so their `??` defaults stay load-bearing.
  The cast is now a plain `as` from the parsed value to the backend-derived type.
- **Where a zod guard is looser than the backend type, the guard wins at
  runtime.** Delivery's `address_1` and `postal_code` may read as null, its
  `tracking_number`, `address` and `items` as absent, and a recent pull's
  `seed` is `number | null` on the backend but optional `number` in the guard.
  The mappers keep their `??` defaults for all of them.
- **A store change reruns the storefront checks.** `deploy-targets.mjs` counts
  every store `types.ts` the storefront imports as a storefront input, so a
  backend-only PR that changes one runs the storefront typecheck.

Not covered, on purpose: request bodies (as in ADR 0017), and store routes
whose responses the storefront reads without a hand-written interface. They
move over when they next change.
