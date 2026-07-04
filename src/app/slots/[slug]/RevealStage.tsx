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
  const { deadlineMs, secondsLeft, expired, states, sell } = useSellWindow({
    offers,
    active: phase === 'review',
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
        <p className="flex h-11 w-full items-center justify-center rounded-xl border border-emerald-400/50 bg-emerald-400/10 text-sm font-bold text-emerald-300">
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
        {flipped && footer(i)}
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
      {/* Clock is honest + always legible: it shows from review entry (before
          the flip), since the shared window drains from review start — not only
          once flipped. The per-card sell footer stays flip-gated (above). */}
      {phase === 'review' && deadlineMs !== null && !expired && (
        <AuctionClock
          deadlineMs={deadlineMs}
          secondsLeft={secondsLeft}
          reduced={reduced}
        />
      )}
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
