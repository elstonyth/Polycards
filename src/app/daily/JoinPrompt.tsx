'use client';

import { openAuth } from '@/components/AuthButton';

/** Logged-out CTA under the dormant calendar (auth modal, no /login page). */
export default function JoinPrompt({
  needsAuth,
  error,
}: {
  needsAuth: boolean;
  error: string;
}) {
  if (!needsAuth) {
    return <p className="mt-6 text-[13px] text-neutral-500">{error}</p>;
  }
  return (
    <button
      type="button"
      onClick={() => openAuth('signup')}
      className="mt-8 inline-flex h-12 w-full items-center justify-center rounded-full bg-neutral-50 text-sm font-semibold text-neutral-950 transition-transform active:scale-[0.98]"
    >
      Join to start your streak
    </button>
  );
}
