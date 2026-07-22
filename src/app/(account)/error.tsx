'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

// Segment boundary for the whole account cluster (11 pages). Without it, a
// failed server action inside any of them bubbles to the root error.tsx and
// takes the page shell with it.
export default function AccountError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] w-full flex-col items-center justify-center gap-4 text-center">
      <h2 className="text-xl font-semibold text-white">Something went wrong</h2>
      <p className="text-sm text-neutral-400">
        We couldn&rsquo;t load this page. Please try again.
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
