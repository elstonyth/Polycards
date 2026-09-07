import Medusa from '@medusajs/js-sdk';

/** Base URL of the Medusa + Mercur backend (see `backend/`). Defaults to local dev. */
export const MEDUSA_BACKEND_URL =
  process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL ?? 'http://localhost:9000';

/**
 * Shared Medusa JS SDK client for the storefront.
 *
 * - Custom backend routes (`/store/*`, `/auth/*` — ours and Mercur's) → the
 *   `Store` port, `store.get/post/del` (src/lib/store.ts). It is the only
 *   thing that should call `sdk.client.fetch`, authenticated or not: it owns
 *   the cookie read, the bearer, the cache mode, the status classification,
 *   the schema check and the one failure log. Do NOT reach for
 *   `sdk.client.fetch` directly, and do not reach for the superseded
 *   `authedFetch` (src/lib/authed-fetch.ts), which exists only for the
 *   suspended `actions/daily.ts`.
 * - Built-in Store/Auth data → `sdk.store.*` / `sdk.auth.*`. These take headers
 *   as a positional argument and return typed responses, so they stay off the
 *   port; an authenticated one passes its own `{ Authorization }`.
 *
 * The publishable key scopes Store API calls to our sales channel; it is a
 * `NEXT_PUBLIC_*` value (safe to expose to the browser).
 */
export const sdk = new Medusa({
  baseUrl: MEDUSA_BACKEND_URL,
  publishableKey: process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
});
