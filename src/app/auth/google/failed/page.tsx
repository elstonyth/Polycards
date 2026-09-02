import type { Metadata } from 'next';
import Link from 'next/link';
import type { GoogleFailReason } from '@/lib/actions/auth';

export const metadata: Metadata = {
  title: 'Sign-in failed',
  description: 'Google sign-in could not be completed.',
  robots: { index: false, follow: false },
};

const DEFAULT_REASON =
  'Google sign-in could not be completed. Please try again.';

// The copy lives HERE, keyed by code: `?reason=` used to be rendered verbatim,
// which let any link put its own sentence under the Polycards header in a
// role="alert". An unknown code shows the default.
const REASON_COPY: Record<GoogleFailReason, string> = {
  origin:
    'Google sign-in is not available at this address. Please try again from polycards.gg.',
  cancelled: 'Google sign-in was cancelled. You can try again.',
  expired: 'Sign-in session expired. Please try again.',
  email: 'Google did not share a verified email.',
  exists:
    'An account with this email already exists. Sign in with your password instead.',
  disabled: 'This account has been disabled. Please contact support.',
  failed: DEFAULT_REASON,
};
const isReason = (r: string): r is GoogleFailReason =>
  Object.hasOwn(REASON_COPY, r);

/**
 * Landing page for a failed Google OAuth exchange. The callback Route Handler
 * (../callback/route.ts) redirects here with a reason CODE as a query param,
 * since a route handler can't render JSX itself.
 */
export default async function GoogleFailedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason = '' } = await searchParams;

  return (
    <main className="px-fluid flex min-h-[70vh] flex-col items-center justify-center gap-4 py-16 text-center">
      <h1 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
        Sign-in didn&apos;t complete
      </h1>
      <p className="max-w-md text-sm text-white/50" role="alert">
        {isReason(reason) ? REASON_COPY[reason] : DEFAULT_REASON}
      </p>
      <Link
        href="/"
        className="mt-2 inline-flex h-11 items-center justify-center rounded-xl bg-neutral-200 px-5 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
      >
        Back to Polycards
      </Link>
    </main>
  );
}
