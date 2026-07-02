# Plan 007 — Dependency CVE triage report

Executed 2026-07-02 against branch `advisor/audit-plans` (base `7ade15b`). No
`npm audit fix --force` was run; no framework major was bumped. Two roots audited:
storefront (`npm`, repo root) and backend (`corepack yarn`, `backend/packages/api`).

## Storefront (root) — actioned

**Before:** 15 advisories (5 high, 9 moderate, 1 low).
**After safe in-range fixes:** 5 advisories (1 high, 4 moderate) — all
framework-transitive with no in-range fix (see below).

### Fixed (in-range, no major)

- `npm audit fix` (no `--force`) resolved 10: **hono, fast-uri, path-to-regexp,
  @hono/node-server, brace-expansion, express-rate-limit, ip-address, js-yaml,
  qs, @babel/core** (all transitive; most arrive via the `shadcn@4.1.0` CLI →
  `@modelcontextprotocol/sdk` → express/hono/ajv chain, or dev tooling).
- Targeted **`next` 16.2.1 → 16.2.10** (patch within Next 16; was blocked only by
  an exact pin, not by semver-major). This cleared the direct-dependency **HIGH**
  Next advisories the audit flagged: RSC-response cache poisoning, App/Pages
  Router middleware/proxy bypass, and the CSP-nonce path. `typecheck` + `build`
  green after the bump.

### Remaining root advisories (no in-range fix — framework/transitive)

| Sev  | Package                          | Direct?                               | Reachable in prod runtime?                                 | Fix path                                                                                                                                     |
| ---- | -------------------------------- | ------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH | `vite`                           | transitive (`@medusajs/types` → vite) | **No — build/dev tool**, never runs in the deployed server | `@medusajs/types` major (Medusa bump)                                                                                                        |
| MOD  | `esbuild`                        | transitive (`vite`)                   | **No — build/dev tool**                                    | `@medusajs/types` major (Medusa bump)                                                                                                        |
| MOD  | `@medusajs/types`                | direct                                | types-only package                                         | Medusa version bump (npm suggests a nonsensical downgrade to 2.11.2)                                                                         |
| MOD  | `next` (residual)                | direct                                | yes                                                        | none forward — 16.2.10 is the latest 16.x patch; npm's only "fix" is a bogus downgrade to `next@9.3.3`. Clears on the next Next minor/major. |
| MOD  | `postcss` (bundled under `next`) | transitive                            | build-time                                                 | Clears when `next` bundles postcss ≥ 8.5.10 (next bump)                                                                                      |

**esbuild/Vite are explicitly dev-only** (Vite here is `@medusajs/types`' build
dependency; it is never executed in the production Next server). No prod exposure.

## Backend (`backend/packages/api`, yarn workspace) — documented, not actioned

**Prod-environment audit:** 1 critical, 10 high, 25 moderate, 2 low. Berry has no
`audit fix`; every high/critical is deep-transitive under **Medusa
(`@medusajs/deps@2.13.4`)**, **Mercur (`@mercurjs/cli@2.1.6`)**, or dev tooling —
none is fixable in-range without a coordinated framework bump, so per the plan
these are documented, not touched (STOP: do not force-resolve framework-pinned
transitives).

| Sev      | Package                                           | Issue                                                       | Pulled by                         | Class                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------- | ----------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CRIT** | `@mikro-orm/core`                                 | SQL injection via crafted object                            | `@medusajs/deps`                  | **Medusa bump** — highest priority; ORM is on the money path                                                                                                                                                              |
| HIGH     | `@mikro-orm/core` / `@mikro-orm/knex`             | prototype pollution / SQLi via identifiers + JSON-path keys | `@medusajs/deps`                  | Medusa bump                                                                                                                                                                                                               |
| HIGH     | `@opentelemetry/exporter-prometheus` / `sdk-node` | Prometheus exporter crash on malformed HTTP                 | `@medusajs/deps`                  | Medusa bump (metrics endpoint — not exposed publicly here)                                                                                                                                                                |
| HIGH     | `form-data`                                       | CRLF injection in multipart field names                     | `axios@1.17.0` (transitive)       | clears on axios bump under the parent                                                                                                                                                                                     |
| HIGH     | `http-proxy-middleware`                           | multipart field injection via CRLF                          | `@acme/api` (dev proxy)           | dev-only                                                                                                                                                                                                                  |
| HIGH     | `lodash`                                          | code injection via `_.template`                             | `@graphql-codegen/plugin-helpers` | **dev tooling** (codegen) — no prod exposure                                                                                                                                                                              |
| HIGH     | `multer`                                          | DoS via deeply nested field names                           | `@acme/api` (media upload)        | low reachability — the upload route is admin-only, auth-gated, mime/magic-byte-validated, ≤20 MB (see media-upload pipeline). Bumping risks the pipeline + needs full HTTP integration re-test; defer to a scoped change. |
| HIGH     | `undici`                                          | WebSocket DoS via fragment count                            | `node-gyp@12.4.0`                 | **build tooling** — no prod exposure                                                                                                                                                                                      |
| HIGH     | `vite`                                            | `server.fs.deny` bypass (Windows)                           | `@mercurjs/cli`                   | **dev/build CLI** — no prod exposure                                                                                                                                                                                      |

## Recommendations

1. **Medusa coordinated bump is the real fix** for the backend critical/high
   (MikroORM SQLi/prototype-pollution, OpenTelemetry). Track as its own initiative
   — it touches the whole backend; re-run this triage after it lands. Target: the
   Medusa 2.x line that ships MikroORM ≥ the patched version.
2. **Storefront: consider moving `shadcn` to `devDependencies`.** It is the CLI
   (pulls `@modelcontextprotocol/sdk` → express/hono/ajv/fast-uri) and is not
   imported by the Next runtime; reclassifying it would drop that whole subtree
   from the prod dependency surface. Left as a recommendation (packaging change,
   not an in-range bump — needs a quick confirm that nothing imports `shadcn` at
   runtime).
3. **Dev-only advisories** (vite/esbuild, http-proxy-middleware, lodash/codegen,
   undici/node-gyp) carry no production-runtime exposure — do not gate a release
   on them.
4. `multer` DoS: low reachability today; fold a `multer` bump into the next
   backend dependency pass and re-run `test:integration:http`.

## Verification

- Root: `npm audit` 15 → 5; `npm run typecheck` exit 0; `npm run build` exit 0.
- Backend: no dependency changed (documented-only), so no backend build/test
  regression from this plan.
- No `--force`, no framework major, no app code changed to paper over a CVE.
- `CSP_ENFORCE` untouched (see plan 006).
