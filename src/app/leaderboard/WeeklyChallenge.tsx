import Link from 'next/link';
import { Trophy, Coins, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PAGE_COLUMN } from '@/components/ui/page-frame';
import type { Challenge } from '@/lib/data/challenge';
import { PrizeCard } from './PrizeCard';
import { StageShowcase } from './StageShowcase';
import { ResetCountdown } from './ResetCountdown';

// The standard's rules block (页面介绍) — rendered under the live content.
const RULES = [
  'Packs opened with normal or bonus credit add their full pull value to your personal weekly ranking and the community pool. Gift packs, the welcome pack and task or challenge reward cards do not count.',
  'As the community reaches each milestone, a new reward stage unlocks.',
  'Rewards are cumulative — a higher stage includes every reward from the stages before it.',
  'At the end of the week, the top 10 on the Weekly Pull Value board receive all rewards unlocked that week.',
];

/** The challenge's title with the reset countdown as a small grey chip. Sits
 *  at the top of the standings column on /leaderboard (the Ranks tab). */
export function ChallengeHead({ challenge }: { challenge: Challenge }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <h2 className="text-xl font-semibold text-neutral-50 sm:text-2xl">
        Weekly Pulled Value
      </h2>
      <ResetCountdown
        resetAt={challenge.resetAt}
        label={challenge.resetLabel}
      />
    </header>
  );
}

/**
 * The community goal: "RM x / RM y", the staged bar and the next-stage line.
 * Rendered between the podium and the other ranks; its top edge carries the
 * podium's blocks. null when the backend sent no pool.
 */
export function CommunityGoal({ challenge }: { challenge: Challenge }) {
  const { pool } = challenge;
  if (!pool) return null;
  return (
    <section
      className="rounded-3xl border border-white/10 bg-neutral-900 p-4 sm:p-5"
      aria-label="Community progress"
    >
      <p className="text-base font-semibold text-neutral-50">Community goal</p>

      {/* The standard's "RM X / RM Y ── NN%" readout. */}
      <p className="font-heading mt-1 text-lg text-white tabular-nums sm:text-2xl">
        {pool.pooled}
        <span className="mx-1.5 text-neutral-500">/</span>
        {pool.topThreshold}
        <span className="ml-2 align-middle text-sm font-semibold text-neutral-400">
          {Math.round(pool.overallPct)}%
        </span>
      </p>

      {/* Checkpoint bar on real data: the fill width IS the pool percentage,
          and the stage milestones ride ON the track as checkpoints that turn
          gold the moment the pool clears them. No overflow-hidden here on
          purpose — the checkpoints stand proud of the track and a clipping
          parent would shave them. */}
      <div className="relative mt-4 mb-1 h-6">
        <div
          className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/10"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pool.overallPct)}
          aria-label={`Community pool at ${pool.pooled} of ${pool.topThreshold}`}
        >
          <div
            className="bg-glacier-grad absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pool.overallPct}%` }}
          />
        </div>

        {challenge.stages.map((s) => {
          const done = s.state === 'complete';
          return (
            // Unscaled anchor box, sized to the checkpoint. Keeping the
            // threshold label a SIBLING of the checkpoint (not a child) keeps
            // the labels in line whatever the checkpoint's state.
            <span
              key={s.stageNumber}
              // Stable hook for the QA script — it asserts checkpoint spacing
              // and label sizing.
              data-challenge-checkpoint=""
              className={cn(
                'absolute top-1/2 h-5 w-5 -translate-y-1/2',
                s.pct > 90 ? 'right-0' : '-translate-x-1/2',
              )}
              style={s.pct > 90 ? undefined : { left: `${s.pct}%` }}
            >
              <span
                className={cn(
                  // Server-rendered and never flips client-side: no
                  // transition, so nothing needs a reduced-motion opt-out.
                  'absolute inset-0 flex items-center justify-center rounded-full',
                  done
                    ? 'bg-chase text-neutral-950'
                    : 'border-2 border-neutral-500 bg-neutral-900 text-transparent',
                )}
                aria-hidden
              >
                <Check className="h-3 w-3" strokeWidth={3.5} />
              </span>
              {/* Thresholds hang off each checkpoint. Hidden below sm — they
                  collide on a narrow bar; the stage pills below carry them on
                  a phone. */}
              <span
                className={cn(
                  'absolute top-full mt-1.5 hidden text-[10px] font-semibold whitespace-nowrap sm:block',
                  // Centred under its checkpoint, except the last one: that
                  // one sits ON the track's right edge, so a centred label
                  // would hang half its width past the bar.
                  s.pct > 90 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                  done ? 'text-chase' : 'text-neutral-400',
                )}
              >
                {s.thresholdCompact}
              </span>
            </span>
          );
        })}
      </div>

      {/* Reserves the row the sm-and-up threshold labels overhang into. */}
      <div className="hidden h-4 sm:block" aria-hidden />

      {pool.next ? (
        <p className="mt-2 text-center text-xs text-neutral-400">
          Stage {pool.next.stageNumber} unlocks at{' '}
          <span className="font-semibold text-neutral-300">
            {pool.next.threshold}
          </span>{' '}
          — {pool.next.remaining} to go
        </p>
      ) : (
        <p className="text-chase mt-2 text-center text-xs font-semibold">
          Every stage is unlocked — grand finale week!
        </p>
      )}
    </section>
  );
}

/** The weekly reward stages: the top of the Ranks page (owner 2026-11-26:
 *  the prizes first, then the community goal, then the player ranks). */
export function RewardStages({ challenge }: { challenge: Challenge }) {
  if (challenge.stages.length === 0) return null;
  return (
    <section className="mt-5" aria-labelledby="reward-stages-heading">
      <h3
        id="reward-stages-heading"
        className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-neutral-400 uppercase"
      >
        Weekly reward stages
      </h3>
      <StageShowcase stages={challenge.stages} />
    </section>
  );
}

/**
 * The cumulative rewards summary, below the standings on /leaderboard.
 */
export function RewardsSummary({ challenge }: { challenge: Challenge }) {
  const { summary } = challenge;
  if (!summary) return null;
  return (
    <div className={PAGE_COLUMN}>
      {/* Rewards Summary — cumulative unlocked rewards for this week's top 10. */}
      <section className="mt-8 rounded-3xl border border-white/10 bg-neutral-900 p-4 sm:p-5">
        <h3 className="text-lg font-semibold text-neutral-50">
          Rewards summary
        </h3>
        {summary.unlockedCount === 0 ? (
          <p className="mt-2 text-sm text-neutral-400">
            No stages unlocked yet — the pool is climbing toward Stage 1. Every
            pack you pay for moves it.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-neutral-400">
              {`${summary.unlockedCount} of ${challenge.stages.length} stages unlocked. Rewards stack — reaching a stage unlocks its rewards on top of every stage before it, so the week's top 10 claim them all together, nothing replaced.`}
            </p>
            {/* Full-width stacked tiles: the deduped card row gets room to
                  breathe (gap, no overlap) instead of a cramped half column. */}
            <div className="mt-4 space-y-4">
              {/* Podium ranks can be configured credits-only — skip the
                    whole tile rather than show the heading over zero
                    thumbnails. */}
              {summary.cards.length > 0 && (
                <div className="rounded-2xl bg-neutral-800/60 p-4 sm:p-5">
                  <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.08em] text-neutral-400 uppercase">
                    <Trophy className="text-chase h-4 w-4" aria-hidden />
                    Top 3 will receive
                  </p>
                  <div className="mt-4 flex flex-wrap items-end justify-center gap-4 sm:justify-start">
                    {summary.cards.map((c, i) => (
                      <PrizeCard
                        key={`${c.name}-${i}`}
                        card={c}
                        glowScale={0.4}
                        sizes="384px"
                        className="h-32"
                      />
                    ))}
                  </div>
                  <p className="mt-3 text-sm text-neutral-400">
                    Podium prize cards (ranks 1–3) from stages 1–
                    {summary.unlockedCount}
                  </p>
                </div>
              )}
              <div className="rounded-2xl bg-neutral-800/60 p-4 sm:p-5">
                <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.08em] text-neutral-400 uppercase">
                  <Coins className="text-chase h-4 w-4" aria-hidden />
                  Top 4–10 will receive
                </p>
                <div className="mt-2 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-heading text-chase text-3xl">
                      {summary.credits}
                    </p>
                    <p className="text-sm text-neutral-400">
                      Total bonus credits across ranks 4–10, stages 1–
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
    </div>
  );
}

/**
 * The challenge rules — rendered at the very bottom of the Ranks page, below
 * the standings (operator request), so the live content stays in easy reach.
 */
export function ChallengeRules() {
  return (
    <section className={cn(PAGE_COLUMN, 'mt-8')} aria-label="How it works">
      <h2 className="text-lg font-semibold text-neutral-50">How it works</h2>
      <ul className="mt-3 space-y-2 rounded-3xl border border-white/10 bg-neutral-900 p-4 sm:p-5">
        {RULES.map((rule) => (
          <li
            key={rule}
            className="flex gap-2.5 text-sm leading-relaxed text-neutral-400"
          >
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-neutral-500" />
            {rule}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-neutral-400">
        Prize cards and slabs sell back as cash you can withdraw once you’ve
        topped up and used your money for packs; credit prizes are bonus credit
        for packs.{' '}
        <Link
          href="/wallet"
          className="font-semibold text-neutral-300 underline-offset-2 hover:text-white hover:underline"
        >
          How it works <span aria-hidden="true">&rarr;</span>
        </Link>
      </p>
    </section>
  );
}
