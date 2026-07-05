// src/app/slots/[slug]/RevealStage.tsx
'use client';

// Reveal orchestrator (flood → transform → review). Owns the shared sell
// window, the all-cards-flip-together gesture, and the auto-vault-at-expiry
// glide-out. Mounted by SlotMachineClient once the reel has settled.
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { WonCard } from '@/lib/actions/packs';
import type {
  SellBackOffer,
  SellBackFn,
  RevealFn,
} from '@/components/SellBackPanel';
import SellConfirmModal from '@/components/SellConfirmModal';
import { rm } from '@/lib/format';
import { rarityRgb, isTopRarity } from '@/lib/rarity';
import type { SoundName } from '@/lib/use-sound';
import type { SfxName } from '@/lib/slot-sfx';
import { useSellWindow } from './useSellWindow';
import { SlabCard } from './SlabCard';
import { GalleryRail } from './GalleryRail';
import { AuctionClock } from './AuctionClock';

export type RevealPhase = 'flood' | 'transform' | 'review';

export function RevealStage({
  phase,
  cards,
  offers,
  winnerRects,
  spriteSrcs,
  reduced,
  onSkip,
  onConclude,
  onSellBack,
  onReveal,
  onSold,
  sfx,
  vibrate,
  play,
}: {
  phase: RevealPhase;
  cards: WonCard[];
  offers: (SellBackOffer | null)[];
  winnerRects: (DOMRect | null)[];
  spriteSrcs: (string | undefined)[];
  reduced: boolean;
  onSkip: () => void;
  /** Called once every card is sold/kept/expired — clears the stage (spec #27). */
  onConclude: () => void;
  onSellBack: SellBackFn;
  onReveal?: RevealFn;
  onSold?: (balance: number) => void;
  sfx: (name: SfxName) => void;
  vibrate: (p: number | number[]) => void;
  play: (name: SoundName) => void;
}) {
  const [flipped, setFlipped] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null);
  const thunked = useRef(false);
  // Sell window anchors to the FLIP, not to card-back presentation (spec #25):
  // the reveal ping fires and the Auction Clock counts only once flipped.
  const { deadlineMs, secondsLeft, expired, states, sell, keep, allConcluded } =
    useSellWindow({
      offers,
      active: phase === 'review' && flipped,
      onReveal,
      onSellBack,
      onSold,
    });

  const anyTop = cards.some((c) => isTopRarity(c.rarity));

  useEffect(() => {
    if (phase === 'transform') sfx('chime');
  }, [phase, sfx]);

  useEffect(() => {
    if (!expired || thunked.current) return;
    thunked.current = true;
    sfx('thunk');
    vibrate([30, 40, 30]);
  }, [expired, sfx, vibrate]);

  // Auto-conclude (spec #27): once every card is terminal, clear the stage after
  // a short beat. Reduced motion still uses the beat so the credited/vault copy
  // is readable before the machine returns; it is short either way.
  useEffect(() => {
    if (!allConcluded) return;
    const id = window.setTimeout(onConclude, reduced ? 400 : 1400);
    return () => clearTimeout(id);
  }, [allConcluded, onConclude, reduced]);

  function flipAll() {
    if (flipped) return;
    setFlipped(true);
    play(anyTop ? 'bigwin' : 'win');
    vibrate(anyTop ? [40, 40, 80] : 30);
  }

  if (phase === 'flood') {
    return (
      <button
        type="button"
        aria-label="Skip to your cards"
        onClick={onSkip}
        className="absolute inset-0 z-20 cursor-default"
      />
    );
  }

  const footer = (i: number) => {
    const offer = offers[i];
    const state = states[i] ?? { phase: 'idle' as const };
    if (!offer) return null;
    if (state.phase === 'sold') {
      return (
        <p className="flex h-11 w-full items-center justify-center rounded-xl border border-buyback/50 bg-buyback/10 text-sm font-bold text-buyback-fg">
          +{rm(state.amount)} credited
        </p>
      );
    }
    if (state.phase === 'vaulted' || expired) {
      return (
        <p className="text-center text-[12px] text-white/55">
          Stored in your vault — sell anytime at {offer.vaultPercent}%
        </p>
      );
    }
    // Both actions after reveal (spec decision #26): Sell (primary) + Keep in
    // vault (quiet secondary, ≥44px). Keep concludes the card immediately —
    // it's already vaulted server-side, so no endpoint call.
    return (
      <>
        <button
          type="button"
          onClick={() => setConfirmIndex(i)}
          disabled={!flipped || state.phase === 'selling'}
          className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-amber-400/60 bg-amber-400/10 text-sm font-bold text-amber-300 transition-colors hover:bg-amber-400/20 disabled:opacity-50"
        >
          {state.phase === 'selling'
            ? 'Selling…'
            : `Sell for ${rm(offer.amount)} (${offer.percent}%)`}
        </button>
        <button
          type="button"
          onClick={() => keep(i)}
          disabled={!flipped || state.phase === 'selling'}
          className="inline-flex h-11 w-full items-center justify-center rounded-xl border border-white/12 bg-white/5 text-[13px] font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
        >
          Keep in vault
        </button>
        {state.phase === 'error' && (
          <p className="text-center text-[12px] font-medium text-red-400">
            {state.message}
          </p>
        )}
      </>
    );
  };

  const cardAt = (i: number) => {
    const card = cards[i]!;
    const state = states[i] ?? { phase: 'idle' as const };
    const vaultedOut = state.phase === 'vaulted';
    return (
      <motion.div
        animate={
          vaultedOut && !reduced
            ? { y: 24, opacity: 0.55, scale: 0.96 }
            : { y: 0, opacity: 1, scale: 1 }
        }
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="flex flex-col items-center gap-3"
      >
        <SlabCard
          card={card}
          rarityRgb={rarityRgb(card.rarity)}
          flipped={flipped}
          onFlip={phase === 'review' && !flipped ? flipAll : undefined}
          reduced={reduced}
          entering={phase === 'transform'}
          enterDelayMs={i * 150}
          fromRect={winnerRects[i] ?? null}
          spriteSrc={spriteSrcs[i]}
        />
        {/* Footer space is ALWAYS reserved (spec decision #23): the card center
            must not shift when the flip stamps in the name + sell/keep buttons.
            The slot holds a fixed min-height and only fills once flipped, so the
            column height is identical before and after the flip. Pre-flip it
            carries the tap-to-reveal hint (spec #42), active card only. */}
        <div className="flex min-h-[7rem] w-full max-w-[300px] flex-col items-center gap-2">
          {flipped
            ? footer(i)
            : phase === 'review' &&
              i === activeIndex && (
                <motion.p
                  aria-hidden
                  animate={
                    reduced ? {} : { y: [0, -4, 0], opacity: [0.55, 1, 0.55] }
                  }
                  transition={{
                    duration: 1.6,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                  className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-white/75"
                >
                  <span aria-hidden>👆</span> Tap the card to reveal
                </motion.p>
              )}
        </div>
      </motion.div>
    );
  };

  return (
    <div
      className="relative z-10 flex w-full flex-col items-center gap-4"
      onPointerDown={phase === 'transform' ? onSkip : undefined}
    >
      {cards.length === 1 ? (
        cardAt(0)
      ) : (
        <GalleryRail
          count={cards.length}
          activeIndex={activeIndex}
          onIndexChange={setActiveIndex}
          reduced={reduced}
        >
          {cardAt}
        </GalleryRail>
      )}
      {/* Clock is FLIP-gated (spec decision #25): the sell window starts at the
          first flip, so pre-flip there is no clock and no countdown UI. Its
          vertical slot is ALWAYS reserved (fixed height) so the clock appearing
          on flip doesn't grow the centered column and nudge the card up — the
          card must stay put (spec decision #23). */}
      <div className="flex h-5 w-full items-center justify-center">
        {phase === 'review' && flipped && deadlineMs !== null && !expired && (
          <AuctionClock
            deadlineMs={deadlineMs}
            secondsLeft={secondsLeft}
            reduced={reduced}
          />
        )}
      </div>
      {confirmIndex !== null && offers[confirmIndex] && (
        <SellConfirmModal
          open
          cardName={offers[confirmIndex]!.cardName}
          image={offers[confirmIndex]!.image}
          fmv={offers[confirmIndex]!.fmv}
          rateType="instant"
          percent={offers[confirmIndex]!.percent}
          netCredit={offers[confirmIndex]!.amount}
          secondsLeft={secondsLeft}
          busy={states[confirmIndex]?.phase === 'selling'}
          onConfirm={() => {
            const i = confirmIndex;
            setConfirmIndex(null);
            void sell(i).then((ok) => {
              if (ok) sfx('credit');
            });
          }}
          onCancel={() => setConfirmIndex(null)}
        />
      )}
    </div>
  );
}
