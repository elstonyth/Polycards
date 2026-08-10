'use client';

// Weekly reward stages as a swipeable rail — the same interaction as the VIP
// ladder (VipLevelCarousel): GalleryRail drag/momentum snapping, 3D neighbor
// peek, desktop chevrons, reduced-motion aware. One card per stage, opening on
// the stage the community pool is currently climbing toward.
import { useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { Check, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  ChallengeCard,
  ChallengeRankReward,
  ChallengeStage,
  ChallengeStageState,
} from '@/lib/data/challenge';
import { GalleryRail } from '@/app/slots/[slug]/GalleryRail';
import { PrizeCard } from './PrizeCard';
import { RankRewardSheet } from './RankRewardSheet';

// Medal-gradient rank numerals (#1ST gold / #2ND silver / #3RD bronze) — the
// prize-grid treatment from the operator's reference design.
// Solid medal colors, not bg-clip-text gradients: the metal is what carries
// the rank, and at 24px a three-stop vertical gradient only cost contrast on
// the top and bottom thirds of each numeral.
const RANKS = [
  { label: '1', suffix: 'ST', tone: 'text-chase' },
  { label: '2', suffix: 'ND', tone: 'text-neutral-300' },
  // amber-500, not amber-600: GalleryRail dims peek neighbours to 0.75, and
  // amber-600 composited over the locked card (#151515) lands at 3.71:1 —
  // under AA for the 12px `suffix` span. amber-500 gives 5.29:1 dimmed /
  // 8.55:1 active. Still bronze against #1ST chase gold and #2ND silver.
  { label: '3', suffix: 'RD', tone: 'text-amber-500' },
] as const;

function RankNumeral({ rank }: { rank: (typeof RANKS)[number] }) {
  return (
    <span
      className={cn('font-heading text-2xl italic leading-none', rank.tone)}
    >
      #{rank.label}
      <span className="text-xs">{rank.suffix}</span>
    </span>
  );
}

// Card surface (border + tint) per stage state. `null` (backend sent no
// progress) falls to the muted locked surface. Icon/badge rendering below stays
// inline — each state renders a structurally different element, so a map there
// would obscure more than it collapses.
const STAGE_SURFACE: Record<ChallengeStageState, string> = {
  active: 'border-chase/60 bg-chase/[0.06]',
  complete: 'border-white/15 bg-white/[0.04]',
  locked: 'border-white/5 bg-white/[0.02]',
};

function StageCard({
  stage,
  pooled,
}: {
  stage: ChallengeStage;
  pooled: string | null;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const pct = Math.round(stage.progressPct ?? 0);
  // Podium = ranks 1-3 that actually have a card; the tile IS the card art, so
  // it shows no credits. KNOWN LIMITATION: credits configured on ranks 1-3 are
  // displayed NOWHERE — a credits-only top-3 rank has no tile, and the sheet
  // below only ever receives ranks 4-10. Migrated config is card-only at ranks
  // 1-3 (plan 057), so this can't occur yet; revisit when the admin editor can
  // set credits on the podium.
  const podium = stage.rankRewards.filter(
    (r): r is ChallengeRankReward & { card: ChallengeCard } =>
      r.rank <= 3 && r.card !== null,
  );
  const rest = stage.rankRewards.filter((r) => r.rank >= 4);
  return (
    <div
      className={cn(
        // Width comes from the rail item (--slab-w on the wrapper below) so
        // the prize grid scales with the phone instead of clamping at 300px.
        'mx-auto flex w-full flex-col rounded-2xl border p-4 sm:p-5',
        STAGE_SURFACE[stage.state ?? 'locked'],
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'font-heading text-3xl',
            stage.state === 'locked' ? 'text-white/60' : 'text-chase',
          )}
        >
          STAGE {stage.stageNumber}
        </span>
        {stage.state === 'complete' && (
          <Check className="text-chase h-5 w-5" aria-label="Unlocked" />
        )}
        {stage.state === 'active' && (
          <span className="bg-chase rounded-full px-2 py-0.5 text-[11px] font-bold text-neutral-950">
            UP NEXT
          </span>
        )}
        {stage.state === 'locked' && (
          <Lock className="h-4 w-4 text-white/60" aria-label="Locked" />
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-400">
        Unlock at{' '}
        <span className="font-semibold text-neutral-200">
          {stage.threshold}
        </span>
      </p>

      {/* Prize grid (reference design): each podium rank gets ITS card — `rank`
          is carried on the row, so a dropped card never shifts a lower one
          under the wrong numeral — plus a 4th tile that OPENS the ranks 4-10
          sheet (the per-rank table can hold seven more prizes than this grid
          can show). PrizeCard renders the art unoptimised (admin picker
          pattern), so backend-hosted art needs no Next remote-image config. */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {podium.map((r) => (
          <div
            key={r.rank}
            className="flex flex-col rounded-xl border border-white/5 bg-white/[0.04] p-2.5"
          >
            <RankNumeral rank={RANKS[r.rank - 1]!} />
            {/* Halo scaled right down — at this size the full 44px glow is
                wider than the card. The frame rule (graded slab → prism, raw
                art → plain img) and the "View Details" link live in
                PrizeCard. */}
            <PrizeCard
              card={r.card}
              glowScale={0.25}
              sizes="256px"
              className="mx-auto mt-2 h-20"
              compact
            />
            <p className="mt-2 line-clamp-2 text-[10px] leading-tight font-semibold tracking-wide text-neutral-300 uppercase">
              {r.card.name}
            </p>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label={`View rewards for ranks 4 to 10 of stage ${stage.stageNumber}`}
          className="flex flex-col rounded-xl border border-white/5 bg-white/[0.04] p-2.5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
        >
          {/* Solid chase gold, matching RankNumeral. */}
          <span className="font-heading text-2xl italic leading-none text-chase">
            #4<span className="text-xs">–10TH</span>
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/task/credits-coins.webp"
            alt=""
            loading="lazy"
            decoding="async"
            className="mx-auto mt-2 h-20 object-contain"
          />
          <p className="mt-2 text-[10px] leading-tight font-semibold tracking-wide text-neutral-300 uppercase">
            {rest.length > 0 ? `${rest.length} more prizes` : 'Credits'}
            {/* stage.reward is the SUM across ranks 4-10, not one winner's
                prize — ranks can now be configured individually, so a single
                figure cannot mean "what you get". Labelled as a total. */}
            <span className="text-chase block text-xs">
              {stage.reward} total
            </span>
          </p>
        </button>
      </div>
      <RankRewardSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        stageNumber={stage.stageNumber}
        rewards={rest}
      />

      {/* Community-pool progress toward THIS stage (VIP-card bar pattern). */}
      {stage.progressPct !== null && (
        <div className="mt-4">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="bg-chase h-full rounded-full"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] font-semibold text-neutral-400">
            <span>{stage.state === 'complete' ? stage.threshold : pooled}</span>
            <span>{stage.threshold}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function StageCarousel({
  stages,
  pooled,
}: {
  stages: ChallengeStage[];
  pooled: string | null;
}) {
  const reduced = useReducedMotion() ?? false;
  // Open on the stage the pool is climbing toward (else the last one).
  const activeStage = stages.findIndex((s) => s.state === 'active');
  const [index, setIndex] = useState(
    activeStage >= 0 ? activeStage : Math.max(0, stages.length - 1),
  );

  if (stages.length === 0) return null;

  return (
    // GalleryRail sizes items from --slab-w (default min(64vw,300px), tuned
    // for a single slab image). The 2×2 prize grid needs more room on phones —
    // 82vw keeps a neighbor-peek sliver while the tiles stay comfortable from
    // 320px (SE) up; 360px caps desktop. VIP/reveal rails are untouched.
    <div className="mt-2 [--slab-w:min(82vw,360px)]">
      {/* Stage pills (the VIP-reference tab row): the always-visible map of
          every stage + its state. On phones the dimmed neighbor peek reads as
          background and the chevrons are sm+-only, so without this row nothing
          says other stages exist. Tap = jump; stays in sync with swipes. */}
      <div
        role="group"
        aria-label="Challenge stages"
        className="mb-3 flex flex-wrap items-center justify-center gap-2"
      >
        {stages.map((s, i) => (
          <button
            key={s.stageNumber}
            type="button"
            aria-pressed={i === index}
            aria-label={`Stage ${s.stageNumber}${
              s.state === 'complete'
                ? ' (unlocked)'
                : s.state === 'locked'
                  ? ' (locked)'
                  : ''
            }`}
            onClick={() => setIndex(i)}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-bold transition-colors',
              i === index
                ? 'bg-chase text-neutral-950'
                : s.state === 'complete'
                  ? 'text-chase bg-neutral-800 hover:bg-neutral-700'
                  : 'bg-neutral-900 text-white/60 hover:text-white/80',
            )}
          >
            {s.state === 'complete' && i !== index && (
              <Check className="h-3 w-3" aria-hidden />
            )}
            {s.state === 'locked' && i !== index && (
              <Lock className="h-3 w-3" aria-hidden />
            )}
            Stage {s.stageNumber}
          </button>
        ))}
      </div>
      <GalleryRail
        count={stages.length}
        activeIndex={index}
        onIndexChange={setIndex}
        reduced={reduced}
      >
        {(i) => (
          // GalleryRail only calls children(i) for 0 <= i < count (same
          // non-null pattern as VipLevelCarousel).
          <StageCard stage={stages[i]!} pooled={pooled} />
        )}
      </GalleryRail>
    </div>
  );
}
