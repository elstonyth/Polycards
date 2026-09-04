import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import Reveal from '@/components/Reveal';
import { RankGlyph } from '@/components/RankGlyph';
import type { LeaderboardEntry } from '@/lib/data/leaderboard';

/**
 * Board 05 — THE FLOOR PAYS OUT. Renders the top-3 weekly rippers; the whole
 * section hides when the ledger is empty (the VIP loop teaser that used to
 * fill that gap was removed on operator request, 2026-08-02).
 * The stat trio (paid out / packs ripped / collectors) arrives with the Phase 3
 * backend aggregate — no fake zeros before then.
 */
export default function TheGame({
  topRippers,
}: {
  topRippers: LeaderboardEntry[];
}) {
  const podium = topRippers.slice(0, 3);
  // Without the podium this section is a bare heading — skip it entirely.
  if (podium.length === 0) return null;

  return (
    <section aria-labelledby="game-heading" className="px-fluid mt-14 w-full">
      <h2 id="game-heading" className="font-heading text-2xl text-white">
        THE FLOOR PAYS OUT
      </h2>

      <div className="mt-4 flex flex-col gap-3 lg:flex-row">
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
              {podium.map((entry) => (
                <li key={entry.rank} className="flex items-center gap-3">
                  <RankGlyph rank={entry.rank} />
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
      </div>
    </section>
  );
}
