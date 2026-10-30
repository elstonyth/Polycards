import type { ReactNode } from 'react';
import { PageTransition } from '@/components/PageTransition';

// The root template only remounts when the top-level segment changes, and
// every account page shares the (account) group — this one animates moves
// between them (vault -> lucky draw, wallet -> settings...).
export default function Template({ children }: { children: ReactNode }) {
  return <PageTransition>{children}</PageTransition>;
}
