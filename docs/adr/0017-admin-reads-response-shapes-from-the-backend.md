# The admin reads response shapes from the backend

The admin used to copy every backend response shape by hand: 132 fetchers in
`apps/admin/src/lib/admin-rest.ts`, each with its own type, and none checked
against what the route sends. A route change touched four or five files, and a
mismatch only showed up on the page.

Now a route's JSON body is written once, beside the route, and both sides are
checked against it. The P&L report (`api/admin/profit-report/pnl`) is the first;
the other areas move one at a time, the most-changed first.

- **The shape lives in a `types.ts` next to the route**, types only. The handler
  declares `res: MedusaResponse<Shape>`, so the backend fails the typecheck if it
  sends something else. Where a module already types a part (the P&L sections in
  `modules/packs/pnl*.ts`), `types.ts` re-exports it instead of writing it again.
- **The admin imports it as `@acme/api/admin/<route path>`**, a types-only entry
  in the api package's `exports` (`./admin/*` → `./src/api/admin/*/types.ts`).
  It has no runtime target, so a value import through it fails the admin build,
  and backend code cannot reach the admin bundle that way.
- **The admin typecheck reads that file and everything it imports**, so a
  `types.ts` imports only pure modules, never `service.ts`. CI runs the admin
  typecheck in the backend build (`tsc -b` before `vite build`).
- **The shape is the JSON on the wire.** Dates are ISO strings; a handler that
  holds a `Date` sends `.toISOString()`, the same bytes `res.json` already sent.
- **The admin's fetchers stay.** `admin-rest.ts` keeps `getJson` and
  `httpError` (the HTTP status on every failure) and only takes its types from
  the backend. Values the admin needs at runtime, such as a display order, stay in
  the admin, typed against the backend's unions so a change there fails the build.

Not covered, on purpose:

- **Request bodies.** They are untrusted input that each handler checks by hand;
  typing them as if already valid would invite skipping those checks.
- **Copied logic** (pricing rules in `format.ts`, the RTP in `odds-rows.ts`). These
  have parity tests and are a separate question.
- **The Mercur typed client** (`lib/client.ts`, `@acme/api/_generated`). It is a
  starter contract and is left as it is.
