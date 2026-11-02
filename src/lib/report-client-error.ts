/** For the error boundaries. No DSN, no SDK: see instrumentation-client.ts. */
export function reportClientError(error: unknown): void {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  void import('@/lib/sentry-client').then((sentry) =>
    sentry.captureException(error),
  );
}
