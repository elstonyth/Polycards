'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { reloadForVersionSkew } from '@/lib/version-skew';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Report client-side render errors caught by this segment boundary — the
  // common case. (global-error.tsx covers root-layout failures; the
  // instrumentation onRequestError hook covers server-side errors.) A tab
  // stranded on a previous deploy reloads instead: reset() can't cure it.
  useEffect(() => {
    Sentry.captureException(error);
    reloadForVersionSkew(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] w-full flex-col items-center justify-center gap-4 px-fluid text-center">
      <h2 className="text-xl font-semibold text-white">Something went wrong</h2>
      <p className="text-sm text-neutral-400">
        An unexpected error occurred. Please try again.
      </p>
      <button
        onClick={() => reset()}
        className="rounded-lg bg-neutral-800 px-5 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-700 hover:text-white"
      >
        Try again
      </button>
    </div>
  );
}
