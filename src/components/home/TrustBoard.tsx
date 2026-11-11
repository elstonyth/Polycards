import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import Reveal from '@/components/Reveal';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

/**
 * Board before the closer — the trust questions a visitor asks before a first
 * top-up, answered in one place (home critique 2026-11-11: fairness, where the
 * cards are and where they ship were all unanswered on home).
 *
 * Only claims PRODUCT.md allows: own stock, a cryptographically secure server
 * draw, odds shown before opening, delivery within Malaysia and Singapore, and
 * buyback with its context named (instant rate during the reveal, the flat
 * vault rate after). Never "provably fair", never "graded" for every pull,
 * and no link to /fairness (deleted 2026-11-11).
 *
 * An editorial list, not an icon-card grid: hairline rows, no containers.
 */
const POINTS = [
  {
    title: 'Real cards from our own stock',
    body: 'Every card you can pull is a physical card we hold. Keep it in your Vault, have it delivered, or sell it back.',
  },
  {
    title: 'A secure draw, odds first',
    body: 'Every pull is a cryptographically secure random draw on our server, and every pack shows its odds before you open.',
  },
  {
    title: 'Ships to Malaysia & Singapore',
    body: 'Send any card in your Vault to an address in Malaysia or Singapore.',
  },
  {
    title: 'Sell back on the spot',
    body: `During the reveal countdown, sell at the pack's instant rate. After that, eligible Vault cards sell back at ${BUYBACK_RATE_LABEL} of card value.`,
  },
] as const;

export default function TrustBoard() {
  return (
    <Reveal
      as="section"
      aria-labelledby="trust-heading"
      className="px-fluid mt-14 grid w-full gap-x-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
    >
      <div className="flex items-baseline justify-between gap-4 lg:flex-col lg:justify-start">
        <h2 id="trust-heading" className="font-heading text-2xl text-white">
          WHY IT’S REAL
        </h2>
        <Link
          href="/how-it-works"
          className="flex min-h-11 shrink-0 items-center gap-1 text-[13px] font-semibold text-neutral-400 transition-colors hover:text-white motion-reduce:transition-none"
        >
          How it works
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <dl className="mt-2 grid sm:grid-cols-2 sm:gap-x-8 lg:mt-0">
        {POINTS.map(({ title, body }) => (
          <div key={title} className="border-t border-white/10 py-4">
            <dt className="text-[15px] font-semibold text-white">{title}</dt>
            <dd className="mt-1 max-w-[46ch] text-sm leading-relaxed text-neutral-400">
              {body}
            </dd>
          </div>
        ))}
      </dl>
    </Reveal>
  );
}
