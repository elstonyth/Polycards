import Medusa from '@medusajs/js-sdk';

/** Base URL of the Medusa + Mercur backend (see `backend/`). Defaults to local dev. */
export const MEDUSA_BACKEND_URL =
  process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL ?? 'http://localhost:9000';

/**
 * Shared Medusa JS SDK client for the storefront.
 *
 * - Built-in Store/Auth data → `sdk.store.*` / `sdk.auth.*`.
 * - Mercur custom routes (e.g. `/store/seller`) → `sdk.client.fetch()`.
 *
 * The publishable key scopes Store API calls to our sales channel; it is a
 * `NEXT_PUBLIC_*` value (safe to expose to the browser).
 */
export const sdk = new Medusa({
  baseUrl: MEDUSA_BACKEND_URL,
  publishableKey: process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
});
