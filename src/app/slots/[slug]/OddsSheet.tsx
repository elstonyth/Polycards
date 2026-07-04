// src/app/slots/[slug]/OddsSheet.tsx
'use client';

import { useRef } from 'react';
import { X } from 'lucide-react';
import type { Rarity } from '@/lib/packs-data';
import { rarityRgb } from '@/lib/rarity';
import { TIER_COLOR, TIER_BAND, TIER_ORDER } from '@/lib/price-tier';
import { useModalA11y } from '@/lib/use-modal-a11y';

/** The published-odds list itself — overall row + per-rarity rows + caption.
 *  Shared between this sheet and the pack page's odds panel so the two can't
 *  drift (they did during the Epic→Mythical rename). */
export function PublishedOddsList({
  odds,
  overall,
  rounded = 'xl',
}: {
  /** Published rows (rarest-first). */
  odds: { rarity: Rarity; chance: string }[];
  /** Overall win rate %; null hides the overall row. */
  overall: number | null;
  rounded?: 'xl' | '2xl';
}) {
  return (
    <>
      <ul
        className={`overflow-hidden border border-white/10 bg-white/[0.03] ${
          rounded === '2xl' ? 'rounded-2xl' : 'rounded-xl'
        }`}
      >
        {overall !== null && (
          <li className="flex items-center justify-between border-b border-white/5 bg-white/[0.03] px-4 py-3">
            <span className="text-[13px] font-semibold text-white">
              Overall win rate
            </span>
            <span className="text-[13px] font-semibold tabular-nums text-white">
              {overall}%
            </span>
          </li>
        )}
        {odds.map((o) => (
          <li
            key={o.rarity}
            className="flex items-center justify-between border-b border-white/5 px-4 py-3 last:border-b-0"
          >
            <span className="flex items-center gap-2.5 text-[13px] font-medium text-white">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: `rgb(${rarityRgb(o.rarity)})` }}
              />
              {o.rarity}
            </span>
            <span className="text-[13px] tabular-nums text-white/55">
              {o.chance}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 px-1 text-[11px] text-white/35">
        Published rates for this pack.
      </p>
    </>
  );
}

/** Published rarity-odds list (admin-authored, from the backend). Never
 *  exposes the win-rate lock (PRD §3.7/§8). */
export function OddsSheet({
  open,
  onClose,
  odds,
  overall,
}: {
  open: boolean;
  onClose: () => void;
  /** Published rows (rarest-first); null = this pack has no published odds. */
  odds: { rarity: Rarity; chance: string }[] | null;
  overall: number | null;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, open, onClose);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Published pull odds by rarity"
        tabIndex={-1}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-5 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-lg font-bold tracking-tight text-white">
            Pull odds by rarity
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close odds"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {/* Published ⇢ render (even overall-only, tiers empty) — matching the
            pack page's gate, which keys off publishedOdds being set. */}
        {odds ? (
          <PublishedOddsList odds={odds} overall={overall} />
        ) : (
          <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-[13px] text-white/40">
            Odds for this pack haven&apos;t been published yet.
          </p>
        )}

        {/* Glow tiers: cosmetic, keyed off the card's USD value (not rarity).
            Explains the colored ring the reel shows on a win. */}
        <h3 className="mb-2 mt-5 font-heading text-sm font-bold tracking-tight text-white">
          Glow tiers <span className="text-white/40">· by card value</span>
        </h3>
        <ul className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
          {TIER_ORDER.map((t) => (
            <li
              key={t}
              className="flex items-center justify-between border-b border-white/5 px-4 py-3 last:border-b-0"
            >
              <span className="flex items-center gap-2.5 text-[13px] font-medium capitalize text-white">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{
                    background: `rgb(${TIER_COLOR[t]})`,
                    boxShadow: `0 0 6px 1px rgba(${TIER_COLOR[t]}, 0.7)`,
                  }}
                />
                {t}
              </span>
              <span className="text-[13px] tabular-nums text-white/55">
                {TIER_BAND[t]}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
