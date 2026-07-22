import Image from 'next/image';
import { Trophy, Coins } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SlabImage } from '@/components/SlabImage';
import type { Challenge } from '@/lib/data/challenge';
import { StageCarousel } from './StageCarousel';

// The standard's rules block (页面介绍) — rendered under the live content.
const RULES = [
  'Every eligible pack draw adds its pull value to your personal weekly ranking and the community pool.',
  'As the community reaches each milestone, a new reward stage unlocks.',
  'Rewards are cumulative — a higher stage includes every reward from the stages before it.',
  'At the end of the week, the top 10 on the Weekly Pull Value board receive all rewards unlocked that week.',
];

/**
 * Weekly Pulled Value Challenge — hero, community pool, reward stages and the
 * cumulative rewards summary. Lives above the standings on /leaderboard (the
 * Ranks tab): the "This Week" board below IS the board this challenge settles
 * on, so the challenge's own top-10 list is intentionally not repeated here.
 */
export function WeeklyChallenge({ challenge }: { challenge: Challenge }) {
  const { pool, summary } = challenge;

  return (
    // Same width as the standings below — one column down the page. The stage
    // rail sizes items from the viewport (--slab-w: min(82vw,360px)), which
    // still fits this container at every breakpoint (measured).
    <div className="px-fluid mx-auto w-full max-w-md pt-10 lg:max-w-3xl">
      {/* Hero — generated gold trophy emblem (public/images/task, alpha webp) */}
      <header className="text-center">
        <span className="from-chase/15 mx-auto flex h-28 w-28 items-center justify-center rounded-3xl bg-gradient-to-b to-transparent">
          <Image
            src="/images/task/challenge-emblem.webp"
            alt=""
            width={96}
            height={96}
            priority
          />
        </span>
        <h2 className="font-heading mt-4 text-4xl text-white">
          WEEKLY PULLED VALUE CHALLENGE
        </h2>
        <p className="mt-3 text-xs font-medium tracking-wide text-neutral-400 uppercase">
          {challenge.resetLabel}
        </p>
      </header>

      {/* Community Progress — adapted uiverse strong-parrot-96 panel. */}
      {pool && (
        <section
          className="mt-8 rounded-2xl border border-white/10 bg-neutral-900 p-6"
          aria-label="Community progress"
        >
          <div className="flex items-center justify-center gap-2">
            <span
              className="challenge-dot bg-chase h-2 w-2 rounded-full"
              aria-hidden
            />
            <span className="text-xs font-semibold tracking-[0.2em] text-neutral-300 uppercase">
              Community Weekly Pulled Value
            </span>
          </div>

          {/* The standard's "RM X / RM Y ── NN%" readout. */}
          <p className="font-heading mt-4 text-center text-lg text-white sm:text-2xl">
            <span className="text-chase [text-shadow:0_0_10px_rgb(255_176_32_/_0.3)]">
              {pool.pooled}
            </span>
            <span className="mx-2 text-neutral-600">/</span>
            {pool.topThreshold}
            <span className="ml-3 align-middle text-sm font-semibold text-neutral-400">
              {Math.round(pool.overallPct)}%
            </span>
          </p>

          <div
            className="relative mt-4 h-10 overflow-hidden rounded-full bg-white/5"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pool.overallPct)}
            aria-label={`Community pool at ${pool.pooled} of ${pool.topThreshold}`}
          >
            <div
              className="challenge-fill absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${pool.overallPct}%` }}
            />
            <div className="challenge-particles absolute inset-0" aria-hidden />
          </div>

          {/* Milestone markers along the bar (positions = threshold / top) */}
          <div className="relative mt-1.5 h-2 sm:h-9">
            {challenge.stages.map((s) => (
              <span
                key={s.stageNumber}
                className={cn(
                  'absolute top-0 flex flex-col items-center',
                  s.pct > 90 ? 'right-0' : '-translate-x-1/2',
                )}
                style={s.pct > 90 ? undefined : { left: `${s.pct}%` }}
              >
                <span
                  className={cn(
                    'h-2 w-px',
                    s.state === 'complete' ? 'bg-chase/70' : 'bg-white/30',
                  )}
                  aria-hidden
                />
                {/* Labels collide on narrow bars — ticks only below sm; the
                    stage list right below carries the thresholds on mobile. */}
                <span
                  className={cn(
                    'mt-1 hidden text-[10px] font-semibold whitespace-nowrap sm:block',
                    s.state === 'complete' ? 'text-chase' : 'text-neutral-400',
                  )}
                >
                  {s.thresholdCompact}
                </span>
              </span>
            ))}
          </div>

          {pool.next ? (
            <p className="mt-3 text-center text-xs text-neutral-400">
              Stage {pool.next.stageNumber} unlocks at{' '}
              <span className="font-semibold text-neutral-300">
                {pool.next.threshold}
              </span>{' '}
              — {pool.next.remaining} to go
            </p>
          ) : (
            <p className="text-chase mt-3 text-center text-xs font-semibold">
              Every stage is unlocked — grand finale week!
            </p>
          )}
        </section>
      )}

      {/* Weekly Reward Stages — swipeable rail, same interaction as VIP. */}
      <section className="mt-8">
        <h3 className="font-heading text-lg text-white">
          Weekly reward stages
        </h3>
        <StageCarousel
          stages={challenge.stages}
          pooled={pool?.pooled ?? null}
        />
      </section>

      {/* Rewards Summary — cumulative unlocked rewards for this week's top 10. */}
      {summary && (
        <section className="border-chase/20 mt-8 rounded-2xl border bg-gradient-to-b from-neutral-900 to-neutral-950 p-5">
          <h3 className="font-heading text-lg text-white">Rewards summary</h3>
          {summary.unlockedCount === 0 ? (
            <p className="mt-2 text-sm text-neutral-400">
              No stages unlocked yet — the pool is climbing toward Stage 1.
              Every eligible pull moves it.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-neutral-400">
                {`${summary.unlockedCount} of ${challenge.stages.length} stages unlocked. Rewards stack — reaching a stage unlocks its rewards on top of every stage before it, so the week's top 10 claim them all together, nothing replaced.`}
              </p>
              {/* Full-width stacked tiles: the deduped card row gets room to
                  breathe (gap, no overlap) instead of a cramped half column. */}
              <div className="mt-4 space-y-4">
                <div className="rounded-xl border border-white/5 bg-neutral-900 p-5">
                  <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-neutral-300 uppercase">
                    <Trophy className="text-chase h-4 w-4" aria-hidden />
                    Top 3 will receive
                  </p>
                  <div className="mt-4 flex flex-wrap items-end justify-center gap-4 sm:justify-start">
                    {summary.cards.map((c, i) =>
                      // Same rule as the stage tiles: graded prizes wear the
                      // prism frame, raw card art stays an unframed <img>.
                      c.slabImage ? (
                        <SlabImage
                          key={`${c.name}-${i}`}
                          src={c.image}
                          slabSrc={c.slabImage}
                          alt={c.name}
                          frameVariant="prism"
                          glowScale={0.4}
                          sizes="384px"
                          className="h-32"
                        />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={`${c.name}-${i}`}
                          src={c.image}
                          alt={c.name}
                          loading="lazy"
                          decoding="async"
                          className="h-32 object-contain drop-shadow-[0_10px_20px_rgba(0,0,0,0.6)]"
                        />
                      ),
                    )}
                  </div>
                  <p className="mt-3 text-sm text-neutral-400">
                    Every featured card from stages 1–{summary.unlockedCount}
                  </p>
                </div>
                <div className="rounded-xl border border-white/5 bg-neutral-900 p-5">
                  <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-neutral-300 uppercase">
                    <Coins className="text-chase h-4 w-4" aria-hidden />
                    Top 4–10 will receive
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-heading text-chase text-3xl">
                        {summary.credits}
                      </p>
                      <p className="text-sm text-neutral-400">
                        Total credits across ranks 4–10, stages 1–
                        {summary.unlockedCount}
                      </p>
                    </div>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/images/task/credits-coins.webp"
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-24 shrink-0 object-contain"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The challenge rules — rendered at the very bottom of the Ranks page, below
 * the standings (operator request), so the live content stays in easy reach.
 */
export function ChallengeRules() {
  return (
    <section
      className="px-fluid mx-auto mt-8 w-full max-w-md lg:max-w-3xl"
      aria-label="How it works"
    >
      <h2 className="font-heading text-lg text-white">How it works</h2>
      <ul className="mt-3 space-y-2 rounded-2xl border border-white/5 bg-neutral-900/60 p-5">
        {RULES.map((rule) => (
          <li
            key={rule}
            className="flex gap-2.5 text-sm leading-relaxed text-neutral-400"
          >
            <span className="bg-chase/60 mt-2 h-1 w-1 shrink-0 rounded-full" />
            {rule}
          </li>
        ))}
      </ul>
    </section>
  );
}
