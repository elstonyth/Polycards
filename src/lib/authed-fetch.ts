/**
 * The one place the storefront builds an AUTHENTICATED `sdk.client.fetch` to
 * the Medusa backend. Scoped deliberately to that surface: `sdk.store.*` /
 * `sdk.auth.*` take headers positionally and still pass their own bearer.
 *
 * Every `src/lib/data` getter and `src/lib/actions` action used to hand-roll
 * the same envelope — `Authorization: Bearer <cookie jwt>` plus `cache:
 * 'no-store'` — around `sdk.client.fetch`. That is transport, not policy, and
 * it belongs in one module so a change to it (a header, a status probe, a
 * timeout) lands once instead of 50 times.
 *
 * What this deliberately does NOT own:
 *
 * - **Reading the cookie.** Callers keep `const token = await getAuthToken();
 *   if (!token) return <their own logged-out value>;`. That branch is not
 *   boilerplate: the modules disagree about it ON PURPOSE — `[]`, `null`,
 *   `{ hasPassword: true }`, a thrown error, or `{ ok:false, needsAuth:true }`
 *   — and each caller's `try` also guards its `parseOne`/`parseList` mapping,
 *   so hoisting the failure branch out of the `catch` would let a parse throw
 *   escape as an unhandled action rejection.
 * - **Error COPY.** See src/lib/errors.ts: each caller passes its own ordered
 *   rules to `friendlyError`, and a shared table would change which message a
 *   given error maps to.
 *
 * It also does NOT give callers a status they could not already reach.
 * `sdk.client.fetch` has always rejected with `FetchError` carrying `.status`
 * — `data/cards.ts` was reading it directly before this module existed. What
 * this module owes callers is only that it does not get in the way: it lets
 * that rejection through untouched, so `httpStatus()` (src/lib/errors.ts)
 * keeps working through it, and so a `cached()` loader still sees a rejection
 * to evict on (src/lib/ttl-cache.ts).
 *
 * The win is narrower than "one interface for every backend call", and worth
 * stating honestly: hand-written `Authorization: Bearer <jwt>` in src/lib went
 * from 58 occurrences to 10. That is a security-relevant literal, and the
 * fewer places that build it the better.
 *
 * The 10 that remain are NOT oversights: they are `sdk.store.*` / `sdk.auth.*`
 * calls, which take headers as a positional argument rather than a `FetchArgs`
 * object, plus the multipart avatar upload in actions/profile-appearance.ts.
 * A second wrapper for that signature would be more code than the duplication
 * it removes. See the routing table in src/lib/medusa.ts.
 */
import type { FetchArgs } from '@medusajs/js-sdk';
import { sdk } from '@/lib/medusa';

/**
 * `sdk.client.fetch` with the customer bearer and `cache: 'no-store'` attached.
 *
 * Rejects exactly as `sdk.client.fetch` does — a non-2xx throws `FetchError`
 * with `.status` intact — so it is transparent to failure and safe inside a
 * `cached()` loader, which requires its loader to throw (src/lib/ttl-cache.ts).
 *
 * `token` is `string | undefined` for the one route with OPTIONAL auth
 * (`/store/free-pack`, whose answer differs for a guest rather than 401ing):
 * with no token the header is omitted rather than sent as `Bearer undefined`.
 * Callers that REQUIRE auth must still guard first — that guard is where their
 * own logged-out answer lives.
 *
 * `init` overrides the defaults (both `cache` and any header, `Authorization`
 * included), so a caller can add e.g. an `Idempotency-Key` without losing it.
 *
 * `cache: 'no-store'` is the default because these are per-customer reads. Do
 * not read that as "no-store is free under Next 16" — the framework default is
 * `auto no cache`, which still fetches once at build time for a statically
 * prerenderable route. It happens to be inert at today's call sites only
 * because each reads `cookies()` via `getAuthToken()` first, which already
 * makes the route dynamic.
 */
export function authedFetch<T>(
  token: string | undefined,
  path: string,
  init: FetchArgs = {},
): Promise<T> {
  return sdk.client.fetch<T>(path, {
    cache: 'no-store',
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
}
