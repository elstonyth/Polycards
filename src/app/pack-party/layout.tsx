import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { features } from '@/lib/features';

// Gate the whole /pack-party segment on the feature flag from a server layout —
// reliable 404 status regardless of the page being a client component. Flip the
// flag (see src/lib/features.ts) to restore the route.
export default function PackPartyLayout({ children }: { children: ReactNode }) {
  if (!features.packParty) notFound();
  return children;
}
