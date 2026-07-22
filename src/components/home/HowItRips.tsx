import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import Reveal from '@/components/Reveal';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

const STEPS = [
  {
    num: '01',
    title: 'BUY CREDITS',
    copy: 'Top up in seconds. RM in, credits out.',
  },
  {
    num: '02',
    title: 'RIP THE REEL',
    copy: 'Spin the pack. Watch the reveal land.',
  },
  {
    num: '03',
    title: "IT'S REAL",
    copy: (
      <>
        Every pull is a real graded slab: vault it, ship it, or sell back at{' '}
        <span className="text-buyback-fg font-semibold">
          {BUYBACK_RATE_LABEL}
        </span>
        .
      </>
    ),
  },
] as const;

/**
 * Board 03 — HOW IT RIPS. Three numbered editorial rows; the old trust chips
 * live inside the step copy now (trust reads as how-it-works, not badges).
 */
export default function HowItRips() {
  return (
    <section aria-labelledby="how-heading" className="px-fluid mt-14 w-full">
      <div className="flex items-baseline justify-between">
        <h2 id="how-heading" className="font-heading text-2xl text-white">
          HOW IT RIPS
        </h2>
        <Link
          href="/how-it-works"
          className="flex min-h-11 items-center gap-1 text-[13px] font-semibold text-neutral-400 transition-colors hover:text-white"
        >
          How it works
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <div className="mt-4 flex flex-col gap-3 lg:flex-row">
        {STEPS.map((step, i) => (
          <Reveal key={step.num} delay={i * 90} className="flex-1">
            {/* h-full: the 3rd step's copy runs two lines — without it the
                cards size to content and the row's bottoms stop aligning. */}
            <div className="flex h-full items-start gap-4 rounded-2xl border border-white/10 bg-neutral-900 p-4">
              <span className="font-heading text-4xl leading-none text-neutral-700">
                {step.num}
              </span>
              <div>
                <p className="font-heading text-base text-white">
                  {step.title}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                  {step.copy}
                </p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
