// src/app/slots/[slug]/RevealStage.tsx
'use client';

// Reveal orchestrator (flood → transform → review). Owns the shared sell
// window, the all-cards-flip-together gesture, and the auto-vault-at-expiry
// glide-out. Mounted by SlotMachineClient once the reel has settled.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { motion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { SLAB_ASPECT } from '@/components/SlabImage';
import type { WonCard } from '@/lib/actions/packs';
import type { SellBackOffer, SellBackFn, RevealFn } from './useSellWindow';
import SellConfirmModal from '@/components/SellConfirmModal';
import { rm } from '@/lib/format';
import { FREE_PULL_LOCKED_MESSAGE } from '@/lib/packs-data';
import { rarityRgb, isTopRarity, rarityWinVolume } from '@/lib/rarity';
import type { SoundName } from '@/lib/use-sound';
import type { SfxName } from '@/lib/slot-sfx';
import { useSellWindow } from './useSellWindow';
import {
  CARD_STAGGER_MS,
  CONCLUDE_DELAY_MS,
  type RevealPhase,
} from '@/lib/reveal-phase';
import { SlabCard } from './SlabCard';
import { GalleryRail } from './GalleryRail';
import { AuctionClock } from './AuctionClock';

export function RevealStage({
  phase,
  cards,
  offers,
  winnerRects,
  spriteSrcs,
  reduced,
  demo = false,
  locked = false,
  onSignUp,
  onSkip,
  onConclude,
  onCloseInstant,
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
  /** Guest demo reveal: no sell window, a sign-up CTA instead — and the stage
   *  never auto-concludes (all-null offers read as "concluded" instantly). */
  demo?: boolean;
  /** The open response's `locked` — this pull can't be sold or delivered yet
   *  (the free welcome pull before the account's first PAID open). The pull IS
   *  real and vaulted, so the reveal shows the unlock note where the sell CTA
   *  sits. Keyed off `locked`, NOT off the response's `free`: a welcome pack
   *  claimed after a paid open is already unlocked and keeps its sell offer. */
  locked?: boolean;
  /** Demo-only conversion CTA (openAuth signup). */
  onSignUp?: () => void;
  onSkip: () => void;
  /** Clears the stage back to the idle machine. Fired automatically once every
   *  card is sold/kept/expired (spec #27), and by the demo's own exit button. */
  onConclude: () => void;
  /** End the instant-buyback window server-side when the reveal ends (approach
   *  A: close-on-leave → the vault quotes the flat rate). Fire-and-forget; the
   *  30s deadline is the hard-tab-kill backstop. */
  onCloseInstant?: (pullIds: string[]) => void;
  onSellBack: SellBackFn;
  onReveal?: RevealFn;
  /** Fired after a confirmed sell-back: the new balance, and what this card
   *  credited (so the parent can raise a toast that outlives this stage). */
  onSold?: (balance: number, amount: number) => void;
  sfx: (name: SfxName) => void;
  vibrate: (p: number | number[]) => void;
  play: (name: SoundName, volume?: number) => void;
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

  // A sell that is still on the wire. useSellWindow's expiry sweep deliberately
  // leaves a 'selling' card alone (every other phase flips to 'vaulted'), so
  // this stays true across the deadline — which is exactly when it's needed.
  const selling = states.some((s) => s.phase === 'selling');

  const anyTop = cards.some((c) => isTopRarity(c.rarity));
  // Firmness is global per batch (one FX rate), but derive per-offer anyway:
  // no firm offer ⇒ nothing is sellable now ⇒ no countdown-pressure clock.
  const anyFirm = offers.some((o) => o?.firm);

  useEffect(() => {
    if (phase === 'transform') sfx('chime');
  }, [phase, sfx]);

  useEffect(() => {
    if (!expired || thunked.current) return;
    thunked.current = true;
    sfx('thunk');
    vibrate([30, 40, 30]);
  }, [expired, sfx, vibrate]);

  // AUTO-CONCLUDE (spec #27). Once every card is terminal — sold, kept, or
  // timed out — the stage clears itself back to the idle machine. The explicit
  // "Spin again" / "Done" pair that lived here is gone: acting on the last card
  // (or letting the clock run out) IS the player saying they're finished, and a
  // second press to say so again was the complaint. Returns to the slot only —
  // never auto-spins, so no charge happens without a press.
  //
  // The delay is what makes it read as a conclusion instead of a yank: the last
  // footer state ("+RM x credited", "Stored in your vault") gets to land first.
  // ~CONCLUDE_DELAY_MS, not exactly: if `expired` turns true a render after
  // `allConcluded` (the expiry effect flips idle states to 'vaulted', which
  // satisfies both) the deps change and the timer restarts once. Harmless — the
  // ceiling is 2 × CONCLUDE_DELAY_MS, and the alternative is latching state to
  // shave a beat off a wait nobody times.
  // `!selling` holds the stage open for a sell still on the wire when the clock
  // runs out. Without it, expiry starts the CONCLUDE_DELAY_MS teardown and the
  // player watching the confirm modal's spinner gets the whole stage yanked
  // mid-action. (Before the modal stayed mounted across the request this only
  // cost the "+RM x credited" footer, which is what the note here used to say.)
  // The credit was always safe — it's server-authoritative and refreshBalance
  // has already fired — but the interaction read as a crash. `selling` cannot
  // stick: useSellWindow.sell sets a terminal phase in both try and catch.
  // Demo has its own explicit exit buttons AND reads as concluded instantly
  // (all-null offers), so it must never enter this path.
  // `|| expired`, not `allConcluded` alone — but NOT for the reason this
  // comment used to give. It said a FAILED sell sits at 'error', which
  // allConcluded never accepts; that stopped being true when allConcluded
  // started deriving from resolvedStates, since expirySweep maps 'error' to
  // 'vaulted' (#511). The term still decides one case: the seeding frame, where
  // `states` is empty and allConcluded([]) is false. Keep it — it is also an
  // honest belt on the clock itself, and once the window is closed the card is
  // vaulted server-side anyway, so leaving is always the right move.
  //
  // `onConclude` is depended on directly rather than mirrored through a ref:
  // SlotMachineClient's handleConclude is a useCallback with no deps, so it is
  // stable and cannot restart the timer mid-countdown. If that ever stops being
  // true, the symptom is a reveal that never clears — mirror it then.
  // `flipped &&` is the invariant, not a patch: NEVER conclude a reveal the
  // player has not seen. allConcluded treats a NULL offer as already-concluded,
  // and a real batch produces null offers whenever the backend response carries
  // no pull id (SlotMachineClient builds `builtOffer` as null then) — so an
  // all-null batch reads as concluded the instant `states` seeds, and without
  // this guard the cards would clear themselves 1.4s into 'review', face down.
  // Under the old buttons that same state was harmless: it just showed "Done"
  // early. `expired` already implies flipped (useSellWindow's `active` is
  // `phase === 'review' && flipped`), so this only constrains the other branch.
  useEffect(() => {
    if (
      demo ||
      !flipped ||
      phase !== 'review' ||
      selling ||
      !(allConcluded || expired)
    ) {
      return;
    }
    const id = window.setTimeout(onConclude, CONCLUDE_DELAY_MS);
    return () => clearTimeout(id);
  }, [demo, flipped, phase, selling, allConcluded, expired, onConclude]);

  // Close the instant-buyback window when the reveal ends. This component
  // unmounts when the reveal auto-concludes (phase→idle, above) or the player
  // navigates away, so its cleanup is the single "left the reveal" signal
  // (approach A).
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
    // LOCKED pull (the free welcome pull before the first PAID open) — checked
    // FIRST, above every other branch. The backend sends UNQUOTED_BUYBACK
    // (firm:false, amount 0) for it, which would otherwise fall into the
    // vaulted/expired or non-firm branches and blame the lock on a pricing
    // outage ("sell once rates are back") — the wrong reason entirely. Keep
    // stays, and must: it is the only affordance that concludes the card, and
    // without it the stage sits until the 30s clock expires.
    if (locked) {
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
          {/* Verbatim FREE_PULL_LOCKED_MESSAGE — the same string the backend
              returns if a sell/deliver is attempted anyway. */}
          <p className="text-center text-[11px] leading-tight text-white/50">
            {FREE_PULL_LOCKED_MESSAGE}
          </p>
        </>
      );
    }
    if (state.phase === 'sold') {
      return (
        <p className="flex h-11 w-full items-center justify-center rounded-xl border border-buyback/50 bg-buyback/10 text-sm font-bold text-buyback-fg">
          +{rm(state.amount)} credited
        </p>
      );
    }
    // The card's OWN state, never `|| expired` — do not put the raw clock back
    // in. useSellWindow hands these already swept for the deadline (see
    // resolvedStates), so 'vaulted' here covers expiry AND keeps the sweep's
    // mid-sale exemption: a sell still on the wire when the clock runs out must
    // keep reading "Selling…" until it lands, not claim the card was vaulted
    // and then contradict itself with "+RM x credited" (#511).
    if (state.phase === 'vaulted') {
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
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-chase/50 bg-chase/10 text-sm font-bold text-chase transition-colors hover:bg-chase/20 disabled:opacity-50"
        >
          {state.phase === 'selling' && (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          )}
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
          // Same stagger the transform→review timer waits out (revealTimings),
          // so the sell window never opens over a still-growing slab.
          enterDelayMs={i * CARD_STAGGER_MS}
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
            // Hold the modal open for the round-trip so its busy spinner is the
            // thing the user watches — their eyes are already on the button they
            // just pressed. Closing first left them staring at a static stage
            // with nothing moving. A failed sell still closes; the error copy
            // renders under the card's own Sell button (state.phase 'error').
            // .finally, not .then: every way out of this modal is gated on
            // !busy, so a rejected sell that skipped the close would wedge the
            // page (scroll locked, Escape/backdrop/Cancel all inert) on a money
            // action. `sell` catches internally today — this keeps that from
            // being load-bearing.
            void sell(i)
              .then((ok) => {
                if (ok) play('count'); // credit tally tick roll
              })
              .finally(() => setConfirmIndex(null));
          }}
          onCancel={() => setConfirmIndex(null)}
        />
      )}
    </div>
  );
}
