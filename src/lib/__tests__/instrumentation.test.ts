import { afterEach, describe, expect, it, vi } from 'vitest';

// src/instrumentation.ts loads the server SDK only when a DSN is configured:
// the SDK costs ~35 MB per instance just to load, and prod runs without one.

const loaded = vi.hoisted(() => ({ server: 0, edge: 0, captured: 0 }));
vi.mock('../../../sentry.server.config', () => {
  loaded.server++;
  return {};
});
vi.mock('../../../sentry.edge.config', () => {
  loaded.edge++;
  return {};
});
vi.mock('@sentry/nextjs', () => ({
  captureRequestError: () => {
    loaded.captured++;
  },
}));

async function boot(dsn: string, runtime: 'nodejs' | 'edge') {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', dsn);
  vi.stubEnv('NEXT_RUNTIME', runtime);
  const hook = await import('../../instrumentation');
  await hook.register();
  await hook.onRequestError(
    new Error('x'),
    { path: '/', method: 'GET', headers: {} },
    {
      routerKind: 'App Router',
      routePath: '/',
      routeType: 'render',
      revalidateReason: undefined,
    },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  Object.assign(loaded, { server: 0, edge: 0, captured: 0 });
});

describe('instrumentation', () => {
  it('loads nothing Sentry without a DSN', async () => {
    await boot('', 'nodejs');
    expect(loaded).toEqual({ server: 0, edge: 0, captured: 0 });
  });

  it('loads the server config and reports request errors with a DSN', async () => {
    await boot('http://pk@sentry.test/1', 'nodejs');
    expect(loaded).toEqual({ server: 1, edge: 0, captured: 1 });
  });

  it('loads the edge config on the edge runtime', async () => {
    await boot('http://pk@sentry.test/1', 'edge');
    expect(loaded).toEqual({ server: 0, edge: 1, captured: 1 });
  });
});
