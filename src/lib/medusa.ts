import Medusa from '@medusajs/js-sdk';

/** Base URL of the Medusa + Mercur backend (see `backend/`). Defaults to local dev. */
export const MEDUSA_BACKEND_URL =
  process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL ?? 'http://localhost:9000';

/**
 * Shared Medusa JS SDK client for the storefront.
 *
 * - Built-in Store/Auth data → `sdk.store.*` / `sdk.auth.*`. These take headers
 *   as a positional argument, so an authenticated one still passes its own
 *   `{ Authorization }` — `authedFetch` does not fit their signature.
 * - Mercur custom routes (e.g. `/store/seller`) → `sdk.client.fetch()`.
 * - The same custom routes WITH a customer bearer → `authedFetch()`
 *   (src/lib/authed-fetch.ts), which builds that header in one place. Reach for
 *   `sdk.client.fetch` directly only for a route that takes no auth.
 *
 * The publishable key scopes Store API calls to our sales channel; it is a
 * `NEXT_PUBLIC_*` value (safe to expose to the browser).
 */
export const sdk = new Medusa({
  baseUrl: MEDUSA_BACKEND_URL,
  publishableKey: process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
});
