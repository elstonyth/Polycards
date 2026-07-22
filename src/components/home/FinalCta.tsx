import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';
import { pillVariants } from '@/components/ui/pill';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

/** Board 06 — the closer. One lockup, one pill, one reassurance line. */
export default function FinalCta() {
  return (
    <Reveal as="section" className="px-fluid mt-16 w-full pb-4">
      <div className="flex flex-col items-center py-10 text-center">
        <p className="font-heading text-5xl leading-[0.95] text-white lg:text-7xl">
          YOUR CHASE
          <br />
          IS WAITING
        </p>
        <Link
          href="/slots"
          className={cn(
            pillVariants({ variant: 'primary', size: 'lg' }),
            'mt-8',
          )}
        >
          RIP A PACK
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
        <p className="mt-4 text-[13px] text-neutral-400">
          Real graded slabs · {BUYBACK_RATE_LABEL} buyback
        </p>
      </div>
    </Reveal>
  );
}
