import type { Metadata } from 'next';
import Link from 'next/link';
import Reveal from '@/components/Reveal';
import { pillVariants } from '@/components/ui/pill';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Pull Odds & Verification',
  description:
    'How card selection works and the current availability of independent per-pull verification.',
};

export default function FairnessPage() {
  return (
    <div className="w-full px-fluid py-10">
      <Reveal
        as="h1"
        className="font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl"
      >
        Pull Odds &amp; Verification
      </Reveal>
      <Reveal
        as="p"
        delay={80}
        className="mt-4 max-w-4xl text-sm leading-relaxed text-neutral-400"
      >
        Cards are selected on the server using a cryptographically secure random
        draw and the applicable pack odds. Review the odds on the pack page
        before you open it.
      </Reveal>

      <Reveal
        as="p"
        delay={140}
        className="mt-8 max-w-xl rounded-xl border border-white/10 bg-neutral-900 px-4 py-3.5 text-sm text-neutral-400"
      >
        Independent per-pull verification is not available yet. We do not
        currently publish the proof data needed to reproduce an individual
        result yourself. Signing in does not unlock proofs.
      </Reveal>
      <Reveal delay={180} className="mt-5">
        <Link
          href="/slots"
          className={cn(pillVariants({ variant: 'secondary', size: 'md' }))}
        >
          Browse packs and odds
        </Link>
      </Reveal>
    </div>
  );
}
