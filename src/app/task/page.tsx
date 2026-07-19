import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { Trophy, Coins } from 'lucide-react';
import { pillVariants } from '@/components/ui/pill';
import { cn } from '@/lib/utils';
import { getChallenge, type ChallengeCard } from '@/lib/data/challenge';
import { StageCarousel } from './StageCarousel';

// Live challenge config + real community pool + Weekly Pull Value standings,
// fetched server-side per request (the storefront origin can reach the backend;
// the browser is CORS-blocked) so it reflects the current ledger.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Task',
  description: 'The Weekly Pulled Value Challenge on Polycards.',
};

// The standard's rules block (页面介绍) — rendered under the hero.
const RULES = [
  'Every eligible pack draw adds its pull value to your personal weekly ranking and the community pool.',
  'As the community reaches each milestone, a new reward stage unlocks.',
  'Rewards are cumulative — a higher stage includes every reward from the stages before it.',
  'At the end of the week, the top 10 on the Weekly Pull Value board receive all rewards unlocked that week.',
];

// Featured-card thumbnails — a plain <img> (the admin picker's pattern) so we
// don't need Next remote-image config for backend-hosted card art.
function CardThumbs({
  cards,
  size = 'sm',
}: {
  cards: ChallengeCard[];
  size?: 'sm' | 'lg';
}) {
  if (cards.length === 0) return null;
  return (
    <div className="flex shrink-0 -space-x-3">
      {cards.map((c, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`${c.name}-${i}`}
          src={c.image}
          alt={c.name}
          loading="lazy"
          decoding="async"
          className={cn(
            'shrink-0 rounded-md object-contain ring-2 ring-neutral-900',
            size === 'lg' ? 'h-20 w-14' : 'h-14 w-10',
          )}
        />
      ))}
    </div>
  );
}

export default async function TaskPage() {
  const challenge = await getChallenge();

  // Empty state — challenge off or backend unreachable. Honest placeholder.
  if (!challenge) {
    return (
      <div className="px-fluid mx-auto w-full max-w-md py-16 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-900">
          <Trophy className="text-chase h-7 w-7" aria-hidden />
        </span>
        <h1 className="font-heading mt-4 text-3xl text-white">
          WEEKLY CHALLENGE
        </h1>
        <p className="mx-auto mt-2 max-w-[40ch] text-sm leading-relaxed text-neutral-400">
          The Weekly Pulled Value Challenge is launching soon. Check back for
          community rewards, milestones, and weekly rankings.
        </p>
        <Link
          href="/leaderboard"
          className={cn(pillVariants({ size: 'md' }), 'mt-6')}
        >
          View the leaderboard
        </Link>
      </div>
    );
  }

  const { pool, summary } = challenge;

  return (
    <div className="px-fluid mx-auto w-full max-w-2xl py-16">
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
        <h1 className="font-heading mt-4 text-4xl text-white">
          WEEKLY PULLED VALUE CHALLENGE
        </h1>
        <p className="mt-3 text-xs font-medium tracking-wide text-neutral-500 uppercase">
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
          <p className="font-heading mt-4 text-center text-xl text-white sm:text-2xl">
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
                    s.state === 'complete' ? 'text-chase' : 'text-neutral-500',
                  )}
                >
                  {s.thresholdCompact}
                </span>
              </span>
            ))}
          </div>

          {pool.next ? (
            <p className="mt-3 text-center text-xs text-neutral-500">
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
        <h2 className="font-heading text-lg text-white">
          Weekly reward stages
        </h2>
        <StageCarousel
          stages={challenge.stages}
          pooled={pool?.pooled ?? null}
        />
      </section>

      {/* Rewards Summary — cumulative unlocked rewards for this week's top 10. */}
      {summary && (
        <section className="border-chase/20 mt-8 rounded-2xl border bg-gradient-to-b from-neutral-900 to-neutral-950 p-5">
          <h2 className="font-heading text-lg text-white">Rewards summary</h2>
          {summary.unlockedCount === 0 ? (
            <p className="mt-2 text-sm text-neutral-400">
              No stages unlocked yet — the pool is climbing toward Stage 1.
              Every eligible pull moves it.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-neutral-400">
                {summary.unlockedCount} of {challenge.stages.length} stages
                unlocked so far — rewards stack, nothing is replaced.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-white/5 bg-neutral-900 p-4">
                  <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-neutral-300 uppercase">
                    <Trophy className="text-chase h-4 w-4" aria-hidden />
                    Top 3 will receive
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <CardThumbs cards={summary.cards} size="lg" />
                    <p className="text-sm text-neutral-400">
                      Every featured card from stages 1–{summary.unlockedCount}
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border border-white/5 bg-neutral-900 p-4">
                  <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-neutral-300 uppercase">
                    <Coins className="text-chase h-4 w-4" aria-hidden />
                    Top 4–10 will receive
                  </p>
                  <p className="font-heading text-chase mt-3 text-3xl">
                    {summary.credits}
                  </p>
                  <p className="text-sm text-neutral-400">
                    Combined credits from stages 1–{summary.unlockedCount}
                  </p>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {/* Weekly Pull Value standings — the board the payout settles on. */}
      {challenge.top.length > 0 && (
        <section className="mt-8" aria-label="Weekly Pull Value top 10">
          <h2 className="font-heading text-lg text-white">
            This week&apos;s top pullers
          </h2>
          <ol className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
            {challenge.top.map((t, i) => (
              <li
                key={`${t.rank}-${t.name}`}
                className={cn(
                  'flex items-center gap-3 px-4 py-3',
                  i > 0 && 'border-t border-white/5',
                )}
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold',
                    t.rank === 1 && 'bg-chase text-neutral-950',
                    t.rank === 2 && 'bg-neutral-300 text-neutral-950',
                    t.rank === 3 && 'bg-amber-700 text-amber-50',
                    t.rank > 3 && 'bg-neutral-800 text-neutral-400',
                  )}
                  aria-label={`Rank ${t.rank}`}
                >
                  {t.rank}
                </span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={t.avatar}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-9 w-9 shrink-0 rounded-full bg-neutral-800 object-cover"
                />
                {t.handle ? (
                  <Link
                    href={`/profile/${t.handle}`}
                    className="min-w-0 flex-1 truncate text-sm font-semibold text-white hover:underline"
                  >
                    {t.name}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
                    {t.name}
                  </span>
                )}
                <span className="font-heading shrink-0 text-base text-white tabular-nums">
                  {t.volume}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* How it works — the standard's rules, parked below the live content
          so the standings stay within easy reach (operator request). */}
      <section className="mt-8" aria-label="How it works">
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

      <div className="mt-8 text-center">
        <Link href="/leaderboard" className={cn(pillVariants({ size: 'md' }))}>
          View the full leaderboard
        </Link>
      </div>
    </div>
  );
}
