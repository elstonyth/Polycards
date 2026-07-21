// src/app/leaderboard/RankRewardSheet.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { ChallengeRankReward } from '@/lib/data/challenge';
import { useModalA11y } from '@/lib/use-modal-a11y';

/** The per-rank prize rows themselves — one row per CONFIGURED rank, with its
 *  card and/or credits. Split out of the sheet (same reason as OddsSheet's
 *  PublishedOddsList) so the same rows can render inline elsewhere — an admin
 *  preview, a wider stage panel — without the two drifting apart.
 *
 *  Rows arrive pre-filtered by the data seam: a rank with neither a resolvable
 *  card nor credits is already absent, so nothing here renders empty. */
export function RankRewardList({
  rewards,
}: {
  rewards: ChallengeRankReward[];
}) {
  if (rewards.length === 0) {
    return (
      <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-[13px] text-white/60">
        No rewards are configured for these ranks yet.
      </p>
    );
  }
  return (
    <ul className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
      {rewards.map((r) => (
        <li
          key={r.rank}
          className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0"
        >
          <span className="font-heading w-10 shrink-0 text-base leading-none text-white/70 italic">
            #{r.rank}
          </span>
          {/* Plain <img>, matching the podium tiles: the challenge payload
              ships one already-composited art URL per card (slab_image ??
              image) with no slab/rarity flag, so there is nothing to drive
              SlabImage's framed path — and its raw-card letterbox would
              mis-crop a baked slab. Swap both together when the prism frame
              and an enriched card payload land (plan 057 note, feat/prism-slab-frame). */}
          {r.card ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={r.card.image}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-14 w-10 shrink-0 object-contain drop-shadow-[0_6px_12px_rgba(0,0,0,0.6)]"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src="/images/task/credits-coins.webp"
              alt=""
              loading="lazy"
              decoding="async"
              className="h-14 w-10 shrink-0 object-contain"
            />
          )}
          <div className="min-w-0 flex-1">
            {r.card && (
              <p className="line-clamp-2 text-[11px] leading-tight font-semibold tracking-wide text-neutral-200 uppercase">
                {r.card.name}
              </p>
            )}
            {r.creditsLabel && (
              <p className="text-chase text-xs font-semibold">
                {r.creditsLabel} credits
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Bottom sheet listing a stage's ranks 4-10 prizes. Same hand-rolled pattern
 *  as OddsSheet (this repo has no Dialog primitive): `useModalA11y` supplies
 *  the focus trap, Escape close, scroll lock, and focus restore to the trigger.
 *  ponytail: no enter/exit animation at all, so there is nothing for
 *  prefers-reduced-motion to suppress. */
export function RankRewardSheet({
  open,
  onClose,
  stageNumber,
  rewards,
}: {
  open: boolean;
  onClose: () => void;
  stageNumber: number;
  rewards: ChallengeRankReward[];
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, open, onClose);
  // Portal target only exists client-side; render nothing until mounted so the
  // server and first client pass agree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!open || !mounted) return null;

  // PORTAL, not an in-place render. The trigger lives inside GalleryRail, whose
  // ancestors carry a 3D transform (neighbour peek) AND overflow-hidden (rail
  // clip). `position: fixed` inside a transformed ancestor resolves against
  // THAT ancestor instead of the viewport, so the overlay was being positioned
  // and then clipped inside the rail — backdrop missing, top rows cut off.
  // Escaping to document.body is the fix; verified at 390px.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Stage ${stageNumber} rewards for ranks 4 to 10`}
        tabIndex={-1}
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border-t border-white/10 bg-neutral-900 p-5 pb-[env(safe-area-inset-bottom)] outline-none sm:inset-x-auto sm:bottom-auto sm:max-w-sm sm:rounded-2xl sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-lg font-bold tracking-tight text-white">
            Stage {stageNumber} · ranks 4–10
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close rewards"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <RankRewardList rewards={rewards} />
      </div>
    </div>,
    document.body,
  );
}
