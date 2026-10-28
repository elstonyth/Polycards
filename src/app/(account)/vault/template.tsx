import type { ReactNode } from 'react';
import { PageTransition } from '@/components/PageTransition';

// A template only remounts when its own child segment changes, so each
// segment with child pages needs one for moves inside it to animate.
export default function Template({ children }: { children: ReactNode }) {
  return <PageTransition>{children}</PageTransition>;
}
