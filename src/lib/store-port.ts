/**
 * The `Store` port — the one shape every storefront → backend call takes.
 *
 * Every server action and data loader used to hand-roll the same envelope:
 * read the auth cookie, pick a logged-out answer, `authedFetch`, `parseOne`,
 * handle `null`, `try/catch` → `logger.error` + `friendlyError` +
 * `needsAuth: isAuthError(err)`. That is transport, not policy, and the port
 * owns all of it. An adapter supplies a `Transport` (src/lib/store.ts over the
 * Medusa SDK and the cookie jar; src/lib/store-memory.ts over a route table
 * for tests) and `createStore` runs the envelope ONCE — auth, headers,
 * classification, schema validation, logging — so the two cannot drift.
 *
 * What stays with the caller, on purpose: the logged-out ANSWER (`[]`, `null`,
 * `{ ok:false, needsAuth:true }` — the modules disagree by design) and the
 * error COPY (each action's own ordered `ErrorRule` table, src/lib/errors.ts).
 * The port classifies; the action decides.
 *
 * This module has no runtime imports — no SDK, no `next/headers`, no logger —
 * so a test can `vi.mock('@/lib/store')` and still run this real pipeline
 * underneath `memoryStore`.
 */
import type { ZodType } from '@/lib/data/schemas';

/** The httpOnly cookie carrying the customer JWT. The HTTP adapter reads it;
 *  src/lib/data/customer.ts sets and clears it. */
export const AUTH_COOKIE = '_polycards_jwt';

export type Failure = {
  ok: false;
  /**
   * 401 → `unauthenticated` (also: no cookie at all — then `status` is
   * undefined, because the call never left); 429 → `rate_limited`;
   * 404 → `not_found`; a 2xx whose body failed its schema → `invalid_shape`;
   * every other non-2xx, and a failure that never reached a response →
   * `backend`.
   */
  kind:
    | 'unauthenticated'
    | 'rate_limited'
    | 'not_found'
    | 'invalid_shape'
    | 'backend';
  /** HTTP status when there was a response. */
  status?: number;
  /** The backend's message text — what an action's `ErrorRule` table matches
   *  on. Never shown raw; see src/lib/errors.ts. */
  text: string;
};

export type Result<T> = { ok: true; data: T } | Failure;

export type StoreOptions = {
  /**
   * `required` (default): no cookie → `unauthenticated` without a network hop.
   * `optional`: the bearer rides along when present (a route whose answer
   * differs for a guest rather than 401ing). `none`: the cookie jar is never
   * read — reading it would make a public route dynamic.
   */
  auth?: 'required' | 'optional' | 'none';
  /**
   * Send THIS bearer instead of the cookie's — for the handful of calls whose
   * token is not the session cookie: the post-register Google refresh and the
   * profile-handle read that runs before the cookie is set
   * (actions/auth.ts, data/profiles.ts#fetchProfileHandle).
   *
   * Alternative to `auth`, not a modifier of it: when it is given the cookie
   * jar is never opened and the `required` short-circuit cannot fire, whatever
   * `auth` says.
   */
  bearer?: string;
  query?: Record<string, string | number | boolean>;
  idempotencyKey?: string;
  /**
   * `no-store` by default: these are per-customer reads.
   *
   * `auto` sends NO `cache` key at all — the framework default ("auto no
   * cache"), which is what a PUBLIC loader on a statically prerenderable route
   * needs. An explicit `no-store` fetches on every request "even if
   * Request-time APIs are not detected on the route" (Next 16 docs,
   * functions/fetch.md), i.e. it makes that route dynamically rendered — which
   * would silently cost `src/app/page.tsx` its `revalidate = 15` route cache.
   * Pair it with `auth: 'none'`: either one alone still forces the route
   * dynamic.
   */
  cache?: 'no-store' | 'force-cache' | 'auto';
};

export interface Store {
  get<T>(
    path: string,
    schema: ZodType<T>,
    o?: StoreOptions,
  ): Promise<Result<T>>;
  post<T>(
    path: string,
    schema: ZodType<T>,
    body: unknown,
    o?: StoreOptions,
  ): Promise<Result<T>>;
  /** Takes a body: the saved-accounts route carries the id there. */
  del<T>(
    path: string,
    schema: ZodType<T>,
    body?: unknown,
    o?: StoreOptions,
  ): Promise<Result<T>>;
  /** For `cached()` loaders, whose contract is "loader must throw"
   *  (src/lib/ttl-cache.ts). */
  orThrow<T>(r: Result<T>): T;
}

/** A failed `Result`, as thrown by `orThrow`. `message` is the failure text. */
export class StoreError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.text);
    this.name = 'StoreError';
  }
}

export type StoreMethod = 'GET' | 'POST' | 'DELETE';

/** One call as the port hands it to an adapter — everything that reaches the
 *  wire. `body` and `query` are present only when the caller gave one.
 *  `cache: 'auto'` is the adapter's instruction to send NO cache key (see
 *  `StoreOptions['cache']`), so it is the one field here that is a mode rather
 *  than a literal wire value. */
export type StoreRequest = {
  method: StoreMethod;
  path: string;
  headers: Record<string, string>;
  cache: NonNullable<StoreOptions['cache']>;
  body?: unknown;
  query?: StoreOptions['query'];
};

/** An adapter's answer: the 2xx body, or a failure — with its status when a
 *  response came back at all. `cause` is the underlying error the adapter
 *  caught (e.g. undici's `TypeError: fetch failed`, whose `.cause` names the
 *  socket problem — `ECONNREFUSED`/`ENOTFOUND`/TLS); logged but never surfaced
 *  in the public `Failure`. */
export type Sent =
  | { ok: true; body: unknown }
  | { ok: false; status?: number; text: string; cause?: unknown };

export interface Transport {
  /** The customer bearer, or null when logged out. Not consulted for
   *  `auth: 'none'`. */
  token(): Promise<string | null>;
  send(req: StoreRequest): Promise<Sent>;
}

/** `logger.error`'s shape; the memory adapter passes a no-op. */
type Log = (message: string, ...meta: unknown[]) => void;

const NOT_AUTHENTICATED = 'Not authenticated.';
// Fixed on purpose: zod's own message names fields ("amount", …) that an
// action's text rules would match, and this failure is not the backend's.
const INVALID_SHAPE = 'Unexpected response shape.';

const KIND_BY_STATUS: Record<number, Failure['kind']> = {
  401: 'unauthenticated',
  404: 'not_found',
  429: 'rate_limited',
};

export function createStore(transport: Transport, log: Log): Store {
  async function call<T>(
    method: StoreMethod,
    path: string,
    schema: ZodType<T>,
    body: unknown,
    o: StoreOptions = {},
  ): Promise<Result<T>> {
    const auth = o.auth ?? 'required';
    const token =
      o.bearer ?? (auth === 'none' ? null : await transport.token());
    if (auth === 'required' && !token) {
      return { ok: false, kind: 'unauthenticated', text: NOT_AUTHENTICATED };
    }

    const sent = await transport.send({
      method,
      path,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(o.idempotencyKey ? { 'Idempotency-Key': o.idempotencyKey } : {}),
      },
      cache: o.cache ?? 'no-store',
      ...(body !== undefined ? { body } : {}),
      ...(o.query ? { query: o.query } : {}),
    });

    if (!sent.ok) {
      const kind =
        (sent.status !== undefined && KIND_BY_STATUS[sent.status]) || 'backend';
      const failure: Failure = {
        ok: false,
        kind,
        status: sent.status,
        text: sent.text,
      };
      log(`[store] ${method} ${path}: ${kind}`, failure, sent.cause);
      return failure;
    }

    const parsed = schema.safeParse(sent.body);
    if (parsed.success) return { ok: true, data: parsed.data };
    log(`[store] ${method} ${path}: invalid_shape`, parsed.error.issues);
    return { ok: false, kind: 'invalid_shape', text: INVALID_SHAPE };
  }

  return {
    get: (path, schema, o) => call('GET', path, schema, undefined, o),
    post: (path, schema, body, o) => call('POST', path, schema, body, o),
    del: (path, schema, body, o) => call('DELETE', path, schema, body, o),
    orThrow,
  };
}

function orThrow<T>(r: Result<T>): T {
  if (r.ok) return r.data;
  throw new StoreError(r);
}
