/**
 * In-memory `Store` for tests. Register `'METHOD /path'` routes, let the REAL
 * port pipeline (src/lib/store-port.ts: auth short-circuit, headers,
 * classification, schema validation) run over them, and read back every
 * request that reached the "backend".
 *
 * Point an action's `import { store } from '@/lib/store'` at one of these with
 * `vi.mock('@/lib/store', …)` — see actions/__tests__/vault.test.ts. Nothing
 * beneath the port (SDK, cookies, logger) needs mocking then.
 */
import {
  createStore,
  type Sent,
  type Store,
  type StoreRequest,
} from '@/lib/store-port';

export type RecordedRequest = StoreRequest;

/** `status` defaults to 200. On a non-2xx, `body.message` becomes the failure
 *  text (as the SDK does with a real response), else `HTTP <status>`. */
export type MemoryResponse = { status?: number; body?: unknown };
export type MemoryRoute =
  MemoryResponse | ((req: RecordedRequest) => MemoryResponse);
/** Keyed `'GET /store/vault'`. A `:param` segment matches any one segment. */
export type MemoryRoutes = Record<string, MemoryRoute>;

/** The bearer a `memoryStore` sends unless told otherwise. */
const TEST_TOKEN = 'test-token';

/**
 * A logged-in customer by default; `{ token: null }` is logged out. An
 * unregistered route THROWS — a test double answering 404 for a typo would
 * fail the test on the wrong assertion.
 */
export function memoryStore(
  routes: MemoryRoutes,
  opts: { token?: string | null } = {},
): Store & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const token = opts.token === undefined ? TEST_TOKEN : opts.token;

  const send = async (req: RecordedRequest): Promise<Sent> => {
    requests.push(req);
    const route = matchRoute(routes, req);
    if (route === undefined) {
      const known = Object.keys(routes).join(', ') || 'none';
      throw new Error(
        `memoryStore: no route for ${req.method} ${req.path} (registered: ${known})`,
      );
    }
    const res = typeof route === 'function' ? route(req) : route;
    const status = res.status ?? 200;
    if (status < 300) return { ok: true, body: res.body };
    const message = (res.body as { message?: unknown } | null | undefined)
      ?.message;
    return {
      ok: false,
      status,
      text: typeof message === 'string' ? message : `HTTP ${status}`,
    };
  };

  return {
    ...createStore({ token: async () => token, send }, () => undefined),
    requests,
  };
}

function matchRoute(
  routes: MemoryRoutes,
  req: RecordedRequest,
): MemoryRoute | undefined {
  const want = req.path.split('/');
  for (const [key, route] of Object.entries(routes)) {
    const [method, pattern = ''] = key.split(' ');
    if (method !== req.method) continue;
    const segments = pattern.split('/');
    if (
      segments.length === want.length &&
      segments.every((s, i) => s.startsWith(':') || s === want[i])
    ) {
      return route;
    }
  }
  return undefined;
}
