import Link from 'next/link';
import { ArrowUpRight, Truck } from 'lucide-react';
import { HeroFreePack } from '@/components/home/HeroFreePack';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';
import type { LeaderboardEntry } from '@/lib/data/leaderboard';
import type { RecentFeed } from '@/lib/data/packs';
import { FlowJustPulled } from './FlowJustPulled';
import { FlowSpacers } from './FlowSpacers';
import { FlowTelegram } from './FlowTelegram';

/**
 * Everything below the stage on the preview, in the flow's order (full-flow
 * plan 1): the paged spacers, the opening line (the free pack offer and the
 * ships and buyback line), Just Pulled, Telegram with the trust points and the
 * footer, then the Return and Last spacers. Server-rendered: no client code of
 * its own.
 */
export function FlowSections({
  feed,
  topRippers,
  freePackPromo,
  showOffer,
}: {
  feed: RecentFeed;
  topRippers: LeaderboardEntry[];
  /** A free welcome pack is on offer to a new visitor (getFreePackPromo). */
  freePackPromo: boolean;
  /** The stage has packs: the offer row shows only then. */
  showOffer: boolean;
}) {
  return (
    <>
      <FlowSpacers part="paged" />
      <div data-flow-section="opening">
        {showOffer && (
          <div className="px-fluid flex flex-col items-center">
            <HeroFreePack promo={freePackPromo} />
          </div>
        )}
        <p className="px-fluid mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 pb-8 text-[11px] text-neutral-400 lg:pb-10 lg:text-xs">
          <span className="flex items-center gap-1.5">
            <Truck className="h-3.5 w-3.5" aria-hidden />
            Ships to Malaysia &amp; Singapore
          </span>
          <span className="h-3 border-l border-white/15" aria-hidden />
          <span>{BUYBACK_RATE_LABEL} vault buyback</span>
          <span className="h-3 border-l border-white/15" aria-hidden />
          <Link
            href="/how-it-works"
            className="flex min-h-11 items-center gap-1 font-semibold text-neutral-300 transition-colors hover:text-white"
          >
            How it works <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </p>
      </div>
      <FlowJustPulled feed={feed} topRippers={topRippers} />
      <FlowTelegram />
      <FlowSpacers part="end" />
    </>
  );
}
