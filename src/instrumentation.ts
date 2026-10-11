import type { Instrumentation } from 'next';

// This file must live in src/, next to app/. With a src/ folder Next only looks
// for the instrumentation hook here; at the repo root it was silently skipped,
// so server and edge Sentry never initialised (2026-06-20 to 2026-10-10). CI's
// quality job fails the build if .next/server/instrumentation.js goes missing.
// instrumentation-client.ts is resolved from either place, which is why the
// browser SDK kept working at the root.

// No DSN, no SDK. Loading and initialising the server SDK costs ~35 MB RSS and
// ~0.4 s of startup per instance even with `enabled: false` (measured
// 2026-10-10, @sentry/nextjs 11.4), so nothing Sentry is imported until a DSN
// is configured. The DSN is inlined at build time, so this is decided per
// build.
const sentryOn = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);

export async function register() {
  if (!sentryOn) return;
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Captures errors from Server Components, middleware, and route handlers.
export const onRequestError: Instrumentation.onRequestError = async (
  ...args
) => {
  if (!sentryOn) return;
  const { captureRequestError } = await import('@sentry/nextjs');
  captureRequestError(...args);
};
