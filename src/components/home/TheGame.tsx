import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import Reveal from '@/components/Reveal';
import type { LeaderboardEntry } from '@/lib/data/leaderboard';

/** Medal disc classes, rank 1→3 — mirrors the leaderboard's medalStyle()
 *  (chase gold / silver / bronze) so "See ranks" lands on the same golds. */
const MEDAL = [
  'bg-chase text-neutral-950',
  'bg-neutral-300 text-neutral-950',
  'bg-amber-700 text-amber-50',
] as const;

/**
 * Board 05 — THE FLOOR PAYS OUT. Phase 1 renders two moments: top-3 weekly
 * rippers (hidden when the ledger is empty) and the VIP/referral loop teaser.
 * The stat trio (paid out / packs ripped / collectors) arrives with the Phase 3
 * backend aggregate — no fake zeros before then.
 */
export default function TheGame({
  topRippers,
}: {
  topRippers: LeaderboardEntry[];
}) {
  const podium = topRippers.slice(0, 3);

  return (
    <section aria-labelledby="game-heading" className="px-fluid mt-14 w-full">
      <h2 id="game-heading" className="font-heading text-2xl text-white">
        THE FLOOR PAYS OUT
      </h2>

      <div className="mt-4 flex flex-col gap-3 lg:flex-row">
        {podium.length > 0 && (
          <Reveal className="flex-1">
            <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4">
              <div className="flex items-baseline justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  Top rippers this week
                </p>
                <Link
                  href="/leaderboard"
                  className="flex min-h-11 items-center gap-1 text-[13px] font-semibold text-neutral-400 transition-colors hover:text-white"
                >
                  See ranks
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </div>
              <ol className="mt-2 flex flex-col gap-2">
                {podium.map((entry, i) => (
                  <li key={entry.rank} className="flex items-center gap-3">
                    <span
                      className={`font-heading flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm ${MEDAL[i] ?? MEDAL[2]}`}
                    >
                      {entry.rank}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">
                      {entry.name}
                    </span>
                    <span className="font-heading whitespace-nowrap text-base text-white">
                      {entry.volume}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </Reveal>
        )}

        <Reveal delay={90} className="flex-1">
          {/* justify-center, not -between: this card is shorter than the podium
              beside it, and pinning the link to the bottom left a dead band. */}
          <div className="flex h-full flex-col justify-center gap-3 rounded-2xl border border-white/10 bg-neutral-900 p-4">
            <div>
              <p className="font-heading text-lg leading-snug text-white">
                100 VIP LEVELS. TWO-TIER REFERRALS.
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                Every rip levels you up — and your crew&apos;s rips pay you
                twice.
              </p>
            </div>
            <Link
              href="/how-it-works"
              className="flex min-h-11 w-fit items-center gap-1 text-[13px] font-semibold text-neutral-400 transition-colors hover:text-white"
            >
              Learn more
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
