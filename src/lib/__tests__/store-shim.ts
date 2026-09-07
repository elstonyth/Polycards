/**
 * Shared wiring for any test whose subject imports the `Store` port's HTTP
 * adapter (`import { store } from '@/lib/store'`).
 *
 * `vi.mock` is per-module and hoisted, so it cannot live in here — each test
 * file keeps one line of its own:
 *
 * ```ts
 * import { storeShim, backend } from '@/lib/__tests__/store-shim';
 * vi.mock('@/lib/store', () => ({ store: storeShim }));
 * ```
 *
 * Import this BEFORE the module under test: the factory above runs while that
 * import is being evaluated, and `storeShim` has to exist by then.
 *
 * Then `backend({ 'GET /store/x': { body } })` points the shim at a fresh
 * `memoryStore` and returns it, so the test can read `requests`. Nothing
 * beneath the port (SDK, cookies, logger) is mocked — the real envelope,
 * schema parsing and copy tables run.
 *
 * Not named `*.test.ts` on purpose: vitest collects `src/**\/*.test.ts` only.
 */
import { memoryStore, type MemoryRoutes } from '@/lib/store-memory';
import type { Store } from '@/lib/store';

type Memory = ReturnType<typeof memoryStore>;

let current: Memory | undefined;

// Resolved per call, never captured: `backend()` swaps the backend between
// tests and the shim object itself must stay the same reference (the mock
// factory runs once per file).
const port = (): Memory => {
  if (!current) {
    throw new Error('store-shim: call backend(routes) before the action runs');
  }
  return current;
};

/** What the mocked `@/lib/store` export resolves to. */
export const storeShim: Store = {
  get: (path, schema, o) => port().get(path, schema, o),
  post: (path, schema, body, o) => port().post(path, schema, body, o),
  del: (path, schema, body, o) => port().del(path, schema, body, o),
  orThrow: (r) => port().orThrow(r),
};

/** Point the shim at a fresh in-memory backend; returns it for `requests`. */
export function backend(
  routes: MemoryRoutes,
  opts?: { token?: string | null },
): Memory {
  current = memoryStore(routes, opts);
  return current;
}
