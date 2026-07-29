// src/app/slots/[slug]/RevealStage.tsx
'use client';

// Reveal orchestrator (flood → transform → review). Owns the shared sell
// window, the all-cards-flip-together gesture, and the auto-vault-at-expiry
// glide-out. Mounted by SlotMachineClient once the reel has settled.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { motion } from 'motion/react';
import { SLAB_ASPECT } from '@/components/SlabImage';
import type { WonCard } from '@/lib/actions/packs';
import type { SellBackOffer, SellBackFn, RevealFn } from './useSellWindow';
import SellConfirmModal from '@/components/SellConfirmModal';
import { rm } from '@/lib/format';
import { rarityRgb, isTopRarity, rarityWinVolume } from '@/lib/rarity';
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
  demo = false,
  onSignUp,
  onSkip,
  onConclude,
  onCloseInstant,
  onSpinAgain,
  onSellBack,
  onReveal,
  onSold,
  sfx,
  vibrate,
  play,
  anticipation,
}: {
  phase: RevealPhase;
  cards: WonCard[];
  offers: (SellBackOffer | null)[];
  winnerRects: (DOMRect | null)[];
  spriteSrcs: (string | undefined)[];
  reduced: boolean;
  /** Guest demo reveal: no sell window, a sign-up CTA instead — and the stage
   *  never auto-concludes (all-null offers read as "concluded" instantly). */
  demo?: boolean;
  /** Demo-only conversion CTA (openAuth signup). */
  onSignUp?: () => void;
  onSkip: () => void;
  /** Called once every card is sold/kept/expired — clears the stage (spec #27). */
  onConclude: () => void;
  /** End the instant-buyback window server-side when the reveal ends (approach
   *  A: close-on-leave → the vault quotes the flat rate). Fire-and-forget; the
   *  30s deadline is the hard-tab-kill backstop. */
  onCloseInstant?: (pullIds: string[]) => void;
  /** Deliberate "Spin again" from the concluded reveal: conclude the stage AND
   *  start the next spin in one press. Replaces the old silent auto-conclude so
   *  a stray tap can't trigger a spin. */
  onSpinAgain?: () => void;
  onSellBack: SellBackFn;
  onReveal?: RevealFn;
  onSold?: (balance: number) => void;
  sfx: (name: SfxName) => void;
  vibrate: (p: number | number[]) => void;
  play: (name: SoundName, volume?: number) => void;
  /** Starts the sustained anticipation pad; returns a stop() to call on reveal. */
  anticipation: () => () => void;
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
  // Firmness is global per batch (one FX rate), but derive per-offer anyway:
  // no firm offer ⇒ nothing is sellable now ⇒ no countdown-pressure clock.
  const anyFirm = offers.some((o) => o?.firm);

  useEffect(() => {
    if (phase === 'transform') sfx('chime');
  }, [phase, sfx]);

  // Hold the reveal ambience from the moment the reels stop (`flood`) through
  // the whole face-down wait, so the reel-stop → reveal handoff is continuous:
  // the bed fades IN under the riser (in useSound) and PERSISTS across every
  // reveal phase — the condition stays true from flood→transform→review, so the
  // effect never re-runs and the loop never restarts. The flip (or unmount)
  // fades it out, handing off to the win fanfare in flipAll. Reduced motion
  // skips the theater, so the bed would just be noise there — skip it.
  const holdAnticipation =
    !flipped &&
    !reduced &&
    (phase === 'flood' || phase === 'transform' || phase === 'review');
  useEffect(() => {
    if (!holdAnticipation) return;
    const stop = anticipation();
    return stop;
  }, [holdAnticipation, anticipation]);

  useEffect(() => {
    if (!expired || thunked.current) return;
    thunked.current = true;
    sfx('thunk');
    vibrate([30, 40, 30]);
  }, [expired, sfx, vibrate]);

  // NO auto-conclude (was spec #27). Once every card is terminal the stage used
  // to clear itself back to 'idle' after ~1.4s — but that silently returned the
  // machine to a spin-ready state, so a tap the player meant for the just-
  // revealed cards started a fresh spin instead. The reveal now STAYS until the
  // player deliberately presses "Spin again" (the footer CTA below → onSpinAgain,
  // which concludes and replays in one press). The demo path already ends on its
  // own explicit buttons, so this only ever affected real pulls.

  // Close the instant-buyback window when the reveal ends. This component
  // unmounts when the player concludes (Spin again → phase→idle) or navigates
  // away, so its cleanup is the single "left the reveal" signal (approach A).
  // The pull ids are captured ONCE at mount: handleConclude clears `offers` just
  // before the unmount, so reading it inside the cleanup would find nothing.
  // Demo reveals carry no real pulls. A hard tab-kill won't run this — the 30s
  // deadline is the backstop.
  const closePullIds = useRef<string[] | null>(null);
  if (closePullIds.current === null) {
    closePullIds.current = offers
      .filter((o): o is SellBackOffer => o !== null)
      .map((o) => o.pullId);
  }
  // DEFER the close and cancel it on the next effect setup. React Strict Mode
  // (dev) runs mount→cleanup→mount synchronously; without this the synthetic
  // cleanup would close the window before the reveal even starts, forcing the
  // flat rate for the whole local session. The re-setup clears the timer before
  // it fires; on a REAL unmount nothing re-setups, so the deferred close runs
  // (timers outlive the component). Prod has no Strict double-invoke — this is a
  // dev-correctness guard (CodeRabbit).
  const closeTimer = useRef<number | null>(null);
  useEffect(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    return () => {
      const ids = closePullIds.current ?? [];
      if (demo || ids.length === 0) return;
      closeTimer.current = window.setTimeout(() => onCloseInstant?.(ids), 0);
    };
  }, [demo, onCloseInstant]);

  function flipAll() {
    if (flipped) return;
    setFlipped(true);
    // Louder the higher the best pull: tier-scaled volume on top of the
    // asset ladder (bigwin is mastered hotter than win).
    const bestVolume = Math.max(...cards.map((c) => rarityWinVolume(c.rarity)));
    play(anyTop ? 'bigwin' : 'win', bestVolume);
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
    // Demo pull: nothing was won, so no sell window — convert instead. The
    // honesty copy lives in the persistent controls line + DEMO badge.
    if (demo) {
      return (
        <>
          <button
            type="button"
            onClick={onSignUp}
            className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-white text-sm font-bold text-neutral-950 transition-colors hover:bg-white/90"
          >
            Sign up &amp; pull for real
          </button>
          <button
            type="button"
            onClick={onConclude}
            className="inline-flex h-11 w-full items-center justify-center rounded-xl border border-white/12 bg-white/5 text-[13px] font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            Back to the reel
          </button>
        </>
      );
    }
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
        <p className="text-center text-[12px] text-white/60">
          {offer.firm
            ? `Stored in your vault — sell anytime at ${offer.vaultPercent}%`
            : 'Stored in your vault — sell once rates are back'}
        </p>
      );
    }
    // Non-firm quote (sim finding P1-1): the backend priced this on its FX
    // display fallback and a sell would be refused — never present the amount
    // as a firm, countdown-pressured offer. Keep stays available (it's a pure
    // client-side conclude; the card is already vaulted server-side).
    // Keep + note only (no dead sell-shaped pill): the variant must fit the
    // reserved 7rem footer slot below, or the card shifts on flip and a
    // height-bound phone regains the scroll this redesign removed.
    if (!offer.firm) {
      return (
        <>
          <button
            type="button"
            onClick={() => keep(i)}
            disabled={!flipped}
            className="inline-flex h-11 w-full items-center justify-center rounded-xl border border-white/12 bg-white/5 text-[13px] font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            Keep in vault
          </button>
          {/* copy must stay short: at the --slab-w width floor the batch-rail
              footer is ~96px wide and long copy wraps past the 7rem slot */}
          <p className="text-center text-[11px] leading-tight text-white/50">
            Stored safely — sell when rates return.
          </p>
        </>
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
          className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-chase/50 bg-chase/10 text-sm font-bold text-chase transition-colors hover:bg-chase/20 disabled:opacity-50"
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
            carries the tap-to-reveal hint (spec #42), active card only.
            NOTE: this 7rem is baked into --slab-w's 250px chrome budget (root
            of this component) — every footer variant must fit inside it, and
            changing either side means updating the other. */}
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
    // m-auto (not parent justify-center): auto margins center when the column
    // fits and keep the top edge reachable if the overlay ever has to scroll —
    // justify-center would push the card's top past the scroll origin.
    // --slab-w is THE card width, shared by SlabCard (the slab itself) and
    // GalleryRail (its item step = slab + gutter, so the neighbor peek shows
    // real card, not empty rail). Width- AND height-aware: 100cqh is the
    // reveal overlay's height ([container-type:size] in SlotMachineClient);
    // 250px is the fixed chrome around the card (info stamp 52 + footer 112 +
    // clock 20 + gaps + rail counter). 64vw/300px are the phone/desktop caps;
    // 96px floors pathologically short viewports (the overlay then scrolls as
    // a last resort).
    <div
      className="relative z-10 m-auto flex w-full flex-col items-center gap-3 sm:gap-4"
      style={
        {
          '--slab-w': `max(96px, min(64vw, 300px, calc((100cqh - 250px) * ${SLAB_ASPECT})))`,
        } as CSSProperties
      }
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
        {phase === 'review' &&
          flipped &&
          anyFirm &&
          deadlineMs !== null &&
          !expired && (
            <AuctionClock
              deadlineMs={deadlineMs}
              secondsLeft={secondsLeft}
              reduced={reduced}
            />
          )}
      </div>
      {/* Explicit end-of-reveal controls — shown once every card is concluded
          (sold/kept/expired). Replaces the old silent auto-conclude: the reveal
          now waits for a DELIBERATE press, so a stray tap on the just-revealed
          cards can't start a fresh spin. "Spin again" concludes AND respins in
          one press; "Done" just returns to the idle machine (no charge) — the
          non-spinning exit for a solvent player who is finished, since the
          machine chrome is hidden behind the reveal. Demo has its own buttons. */}
      {!demo && allConcluded && (
        <div className="flex w-full max-w-[300px] flex-col items-center gap-2">
          {onSpinAgain && (
            <button
              type="button"
              onClick={onSpinAgain}
              className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-white text-sm font-bold text-neutral-950 transition-colors hover:bg-white/90"
            >
              Spin again
            </button>
          )}
          <button
            type="button"
            onClick={onConclude}
            className="inline-flex h-11 w-full items-center justify-center rounded-xl border border-white/12 bg-white/5 text-[13px] font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            Done
          </button>
        </div>
      )}
      {confirmIndex !== null && offers[confirmIndex] && (
        <SellConfirmModal
          open
          cardName={offers[confirmIndex]!.cardName}
          image={offers[confirmIndex]!.image}
          slabImage={offers[confirmIndex]!.slabImage}
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
