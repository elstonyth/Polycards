import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Sign-in failed',
  description: 'Google sign-in could not be completed.',
  robots: { index: false, follow: false },
};

const DEFAULT_REASON =
  'Google sign-in could not be completed. Please try again.';

/**
 * Landing page for a failed Google OAuth exchange. The callback Route Handler
 * (../callback/route.ts) redirects here with the human-readable reason as a
 * query param, since a route handler can't render JSX itself.
 */
export default async function GoogleFailedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  return (
    <main className="px-fluid flex min-h-[70vh] flex-col items-center justify-center gap-4 py-16 text-center">
      <h1 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
        Sign-in didn&apos;t complete
      </h1>
      <p className="max-w-md text-sm text-white/50" role="alert">
        {reason || DEFAULT_REASON}
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
