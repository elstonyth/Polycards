/**
 * The `Store` port's HTTP adapter — the ONE place the storefront builds a
 * request to the Medusa backend (contract and pipeline: src/lib/store-port.ts).
 *
 * `sdk.client.fetch` (src/lib/medusa.ts) carries the publishable key; this
 * adds the customer bearer from the httpOnly cookie, `cache: 'no-store'`, and
 * an `Idempotency-Key` when the caller minted one — exactly what `authedFetch`
 * sent, now with the cookie read, the status classification, the schema check
 * and the failure log inside the seam instead of at every call site.
 *
 * `cache: 'no-store'` is the default because these are per-customer reads. Do
 * not read that as "no-store is free under Next 16" — the framework default is
 * `auto no cache`, which still fetches once at build time for a statically
 * prerenderable route. It is inert at today's call sites only because each
 * reads the cookie jar first (`auth: 'required' | 'optional'`), which already
 * makes the route dynamic — and `auth: 'none'` exists precisely so a public
 * loader does not.
 *
 * Only types are re-exported from here. Runtime helpers (`StoreError`,
 * `AUTH_COOKIE`) live in store-port.ts so a test that mocks `@/lib/store`
 * cannot blank them.
 */
import 'server-only';
import { cookies } from 'next/headers';
import type { FetchArgs } from '@medusajs/js-sdk';
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { httpStatus } from '@/lib/errors';
import {
  AUTH_COOKIE,
  createStore,
  type Sent,
  type StoreRequest,
} from '@/lib/store-port';

export type { Store, Result, Failure, StoreOptions } from '@/lib/store-port';

async function send({
  path,
  body,
  cache,
  ...init
}: StoreRequest): Promise<Sent> {
  try {
    const data: unknown = await sdk.client.fetch<unknown>(path, {
      ...init,
      // 'auto' means send no `cache` key at all — the framework default. An
      // explicit 'no-store' would make a statically prerenderable route
      // dynamic, which is not free: it is what `src/app/page.tsx`'s
      // `revalidate = 15` route cache costs. See StoreOptions['cache'].
      ...(cache === 'auto' ? {} : { cache }),
      ...(body !== undefined ? { body: body as FetchArgs['body'] } : {}),
    });
    return { ok: true, body: data };
  } catch (error) {
    // A non-2xx rejects with `FetchError` (status + the backend's message
    // text); a network drop with a plain Error and no status. Either way,
    // `cause` carries the original error through to the log line — a network
    // drop is typically undici's `TypeError: fetch failed`, whose `.cause`
    // names the actual socket problem (ECONNREFUSED/ENOTFOUND/TLS), which
    // `error.message` alone loses.
    return {
      ok: false,
      status: httpStatus(error),
      text: error instanceof Error ? error.message : String(error),
      cause: error,
    };
  }
}

export const store = createStore(
  {
    token: async () => (await cookies()).get(AUTH_COOKIE)?.value ?? null,
    send,
  },
  logger.error,
);
