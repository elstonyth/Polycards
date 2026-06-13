import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { features } from '@/lib/features';

// Gate the whole /marketplace segment on the feature flag. The guard lives in the
// layout (not page.tsx) on purpose: marketplace/loading.tsx makes the page stream,
// which commits a 200 status before the page body runs — so a notFound() inside
// the page renders the not-found UI but with a 200. The layout runs before that
// streaming Suspense, so notFound() here returns a real 404. Flip the flag
// (see src/lib/features.ts) to restore the route.
export default function MarketplaceLayout({
  children,
}: {
  children: ReactNode;
}) {
  if (!features.marketplace) notFound();
  return children;
}
