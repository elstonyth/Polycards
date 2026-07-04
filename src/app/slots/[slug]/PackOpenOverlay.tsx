'use client';

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import Image from 'next/image';
import {
  AnimatePresence,
  animate,
  motion,
  type AnimationPlaybackControls,
} from 'motion/react';
import { ArrowLeft, Zap, Volume2 } from 'lucide-react';
import {
  CARD_FLIP,
  CYL_SPRING,
  DRAG_DEG_PER_PX,
  EASE_BACK,
  EASE_TW,
  FLING_MAX_VEL,
  FLING_PROJECT,
  META_AUTO_ADVANCE_MS,
  META_LABEL_DELAYS,
  META_PILL_DELAY,
  META_VALUE_OFFSET,
  PACK_EXIT,
  SHUFFLE_SPIN,
  SLAB_RISE,
} from '@/lib/motion';
import type { PackCard } from '@/lib/packs-data';
import { SELL_COUNTDOWN_SECS, sellSecondsLeft } from '@/lib/sell-countdown';
import SellConfirmModal from '@/components/SellConfirmModal';
import { rm } from '@/lib/format';

// Rarity → rgb (shared util) drives the glow, pill, and the Pull-celebration
// ribbon color.
import { RARITY_RGB } from '@/lib/rarity';

// Carousel cylinder geometry, measured from the live phygitals demo (6 packs 60°
// apart, radius≈259 at a 318px pack; scaled down here, same ratio). Motion values
// (float, exit drop, slab rise, metadata stagger, flip, glow spin) are frame-measured
// — see docs/research/components/motion-fidelity.spec.md.
const SLOTS = 6;
const STEP = 360 / SLOTS; // 60°
const PACK_W = 196;
const PACK_H = 304;
const RADIUS = 188;

type Stage = 'packs' | 'slab' | 'metadata' | 'pull' | 'card';

// Full-screen pack-opening, frame-matched to the live phygitals flow: an interactive
// 3D pack cylinder (drag/swipe to spin, shuffle, tap to select) → packs drop away →
// a face-down graded slab rises → the metadata suspense screen → (Mythical/Legendary
// only) a rarity "PULL" ribbon → the won card flips in over a spinning glow.
// Reduced motion jumps straight to the card.
export default function PackOpenOverlay({
  card,
  isReal,
  packImage,
  packName,
  category,
  reduced,
  opening,
  marketPriceMyr,
  buyback,
  onSellBack,
  onReveal,
  onClose,
  onOpenAnother,
  onSignUp,
}: {
  card: PackCard;
  isReal: boolean;
  packImage: string;
  packName: string;
  category: string;
  reduced: boolean;
  opening: boolean;
  /** Live MYR market price for THIS pull (raw USD FMV x FX x per-card
   *  multiplier), same number the vault will show once the pull lands there.
   *  Null for demo spins (no backend pull) or an older backend response. */
  marketPriceMyr?: number | null;
  /** Sell-back offer for THIS pull; null for demo spins. */
  buyback?: {
    pullId: string;
    fmv: number;
    percent: number;
    amount: number;
    vaultPercent: number;
    vaultAmount: number;
    /** Fallback instant deadline (epoch ms) if the reveal ping fails. */
    instantDeadlineMs: number;
  } | null;
  onSellBack?: (
    pullId: string,
  ) => Promise<
    | { ok: true; amount: number; percent: number; balance: number }
    | { ok: false; error: string; needsAuth?: boolean }
  >;
  /** Reveal ping — stamps revealed_at server-side and returns the authoritative
   *  instant deadline. Best-effort; on failure the open-response deadline is used. */
  onReveal?: (
    pullId: string,
  ) => Promise<{ ok: true; instantDeadlineMs: number } | { ok: false }>;
  onClose: () => void;
  onOpenAnother: () => void;
  /** Anonymous DEMO spins only: swaps keep/sell for the sign-up conversion
   *  CTA ("nothing recorded, nothing claimable"). Null for real opens and for
   *  logged-in demo spins. */
  onSignUp?: (() => void) | null;
}) {
  const [stage, setStage] = useState<Stage>(reduced ? 'card' : 'packs');
  // Instant sell-back state for the card stage: idle → selling → sold.
  const [sell, setSell] = useState<
    | { phase: 'idle' }
    | { phase: 'selling' }
    | { phase: 'sold'; amount: number; balance: number }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  // Deadline for the instant offer: the reveal ping returns the authoritative,
  // reveal-anchored value; until it resolves (or if it fails) we use the
  // open-response fallback. Wall-clock based so background-tab throttling can't
  // stretch it.
  const [deadlineMs, setDeadlineMs] = useState<number | null>(
    buyback ? buyback.instantDeadlineMs : null,
  );
  const [secondsLeft, setSecondsLeft] = useState(SELL_COUNTDOWN_SECS);
  const sellExpired = secondsLeft <= 0;
  const revealPinged = useRef(false);
  // Confirm-before-sell dialog.
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Fire the reveal ping ONCE when the card is shown, then drive the deadline
  // from its result (falling back to the open-response deadline on failure).
  useEffect(() => {
    if (stage !== 'card' || !buyback || revealPinged.current) return;
    revealPinged.current = true;
    if (!onReveal) return;
    let cancelled = false;
    onReveal(buyback.pullId).then((r) => {
      if (!cancelled && r.ok) setDeadlineMs(r.instantDeadlineMs);
    });
    return () => {
      cancelled = true;
    };
  }, [stage, buyback, onReveal]);

  // Tick the visible countdown to the server deadline.
  useEffect(() => {
    if (stage !== 'card' || deadlineMs === null) return;
    if (sell.phase === 'sold') return;
    const tick = () => setSecondsLeft(sellSecondsLeft(deadlineMs, Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [stage, deadlineMs, sell.phase]);

  async function handleSellBack() {
    if (
      !buyback ||
      !onSellBack ||
      sell.phase === 'selling' ||
      sell.phase === 'sold'
    )
      return;
    setSell({ phase: 'selling' });
    try {
      const res = await onSellBack(buyback.pullId);
      if (res.ok) {
        setSell({ phase: 'sold', amount: res.amount, balance: res.balance });
        setConfirmOpen(false);
      } else {
        setSell({ phase: 'error', message: res.error });
        setConfirmOpen(false);
      }
    } catch {
      // A transport-level throw must never strand the button on "Selling…".
      setSell({
        phase: 'error',
        message: 'Something went wrong. Please try again.',
      });
      setConfirmOpen(false);
    }
  }
  const rgb = RARITY_RGB[card.rarity];
  // Live gates the ribbon celebration by rarity (an Uncommon pull skips straight from
  // metadata to the card; a Mythical pull got the ribbon) — celebrate the top three tiers.
  const celebrate =
    card.rarity === 'Immortal' ||
    card.rarity === 'Legendary' ||
    card.rarity === 'Mythical';

  // GRADE / YEAR parsed from the card name (e.g. "2016 … PSA 10") — live's metadata
  // screen shows YEAR → CATEGORY → GRADE. Never fabricated; Value stands in when the
  // name carries no year.
  const gradeMatch = card.name.match(
    /\b(PSA|CGC|BGS|SGC)\s*(\d+(?:\.\d+)?)\b/i,
  );
  const gradeLabel = gradeMatch
    ? `${gradeMatch[1]!.toUpperCase()} ${gradeMatch[2]!}`
    : null;
  const yearMatch = card.name.match(/\b(19|20)\d{2}\b/);
  const yearLabel = yearMatch ? yearMatch[0] : null;
  const displayValue = marketPriceMyr != null ? rm(marketPriceMyr) : card.value;
  const rows: { label: string; value: string }[] = [
    yearLabel
      ? { label: 'Year', value: yearLabel }
      : { label: 'Value', value: displayValue },
    { label: 'Category', value: category },
    ...(gradeLabel ? [{ label: 'Grade', value: gradeLabel }] : []),
  ];

  // Interactive cylinder driven IMPERATIVELY (ref + direct style writes) so dragging
  // never re-renders the 12 pack images — React state on every pointermove was the lag.
  // Snap/shuffle use Framer Motion's imperative spring on the same ref.
  const cylRef = useRef<HTMLDivElement>(null);
  const rotRef = useRef(0);
  const springRef = useRef<AnimationPlaybackControls | null>(null);
  // vel = smoothed drag velocity in deg/s — released as fling momentum
  const drag = useRef({
    active: false,
    startX: 0,
    startRot: 0,
    moved: false,
    lastX: 0,
    lastT: 0,
    vel: 0,
  });

  const spinTo = (
    target: number,
    opts?: { velocity?: number; tween?: boolean },
  ) => {
    springRef.current?.stop();
    const el = cylRef.current;
    if (!el) return;
    springRef.current = animate(rotRef.current, target, {
      // shuffle = long roulette deceleration; release = spring seeded with the
      // drag velocity so the cylinder carries through instead of braking dead
      ...(opts?.tween
        ? SHUFFLE_SPIN
        : { ...CYL_SPRING, velocity: opts?.velocity ?? 0 }),
      onUpdate: (v) => {
        el.style.transform = `rotateY(${v}deg)`;
        rotRef.current = v;
      },
    });
  };

  // metadata holds (live ≈3.6s), then either the Pull celebration or the card.
  useEffect(() => {
    if (stage === 'metadata') {
      const t = setTimeout(
        () => setStage(celebrate ? 'pull' : 'card'),
        META_AUTO_ADVANCE_MS,
      );
      return () => clearTimeout(t);
    }
    if (stage === 'pull') {
      const t = setTimeout(() => setStage('card'), 1150);
      return () => clearTimeout(t);
    }
  }, [stage, celebrate]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (stage !== 'packs') return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    springRef.current?.stop();
    drag.current = {
      active: true,
      startX: e.clientX,
      startRot: rotRef.current,
      moved: false,
      lastX: e.clientX,
      lastT: e.timeStamp,
      vel: 0,
    };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current.active || !cylRef.current) return;
    const d = drag.current;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) > 6) d.moved = true;
    const deg = d.startRot + dx * DRAG_DEG_PER_PX;
    cylRef.current.style.transform = `rotateY(${deg}deg)`; // imperative — no re-render
    rotRef.current = deg;
    // velocity in deg/s, exponentially smoothed — this is the fling momentum
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) {
      const inst = ((e.clientX - d.lastX) * DRAG_DEG_PER_PX * 1000) / dt;
      d.vel = 0.8 * inst + 0.2 * d.vel;
      d.lastX = e.clientX;
      d.lastT = e.timeStamp;
    }
  };
  const onPointerUp = () => {
    if (!drag.current.active) return;
    const { moved, vel } = drag.current;
    drag.current.active = false;
    if (!moved) {
      setStage('slab'); // a tap (not a drag) → select → packs drop, slab rises
      return;
    }
    // fling: project the release velocity forward, snap THAT to a slot, and seed
    // the spring with the same velocity so motion carries through smoothly
    const v = Math.max(-FLING_MAX_VEL, Math.min(FLING_MAX_VEL, vel));
    const projected = rotRef.current + v * FLING_PROJECT;
    spinTo(Math.round(projected / STEP) * STEP, { velocity: v });
  };

  const shuffle = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const target =
      Math.round(rotRef.current / STEP) * STEP +
      360 * 2 +
      STEP * (1 + Math.floor(Math.random() * (SLOTS - 1)));
    spinTo(target, { tween: true }); // roulette-style decelerating spin
  };

  return (
    <div
      className="fixed inset-0 z-[80] overflow-hidden bg-black motion-safe:animate-[fadeIn_0.3s_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-label={`Opening ${packName}`}
      onClick={() => {
        // Tap-to-advance (live's metadata screen is itself a button): slab → metadata
        // → (pull, top rarities only) → card, instead of waiting out the timers.
        if (stage === 'slab') setStage('metadata');
        else if (stage === 'metadata') setStage(celebrate ? 'pull' : 'card');
        else if (stage === 'pull') setStage('card');
      }}
    >
      {/* top bar */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close"
        className="absolute left-4 top-4 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      >
        <ArrowLeft className="h-5 w-5" aria-hidden />
      </button>
      <div className="absolute right-4 top-4 z-20 flex gap-2 text-white/40">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5">
          <Zap className="h-4 w-4" aria-hidden />
        </span>
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5">
          <Volume2 className="h-4 w-4" aria-hidden />
        </span>
      </div>
      {stage !== 'packs' && (
        <p className="absolute top-5 left-1/2 z-20 -translate-x-1/2 text-[11px] font-medium uppercase tracking-[0.3em] text-white/35">
          {isReal ? '1 of 1' : 'Demo spin'}
        </p>
      )}
      {/* Tap-to-continue hint during the auto-playing reveal stages */}
      {(stage === 'metadata' || stage === 'pull') && (
        <p className="pointer-events-none absolute bottom-10 left-1/2 z-20 -translate-x-1/2 text-[11px] font-medium uppercase tracking-[0.3em] text-white/35 motion-safe:animate-pulse">
          ● Tap to continue
        </p>
      )}

      <AnimatePresence>
        {/* STAGE 1 — interactive 3D pack cylinder; on select the packs DROP away
            (measured: +430px, 0.48s, ease(0.55,0,0.85,0.4)) while the UI fades fast */}
        {stage === 'packs' && (
          <motion.div
            key="packs"
            className="absolute inset-0 flex select-none flex-col items-center justify-center gap-12"
            exit={
              reduced
                ? { opacity: 0 }
                : { y: 430, opacity: 0.35, transition: PACK_EXIT }
            }
            // the select-tap must not bubble to the overlay's tap-to-advance handler —
            // with AnimatePresence the block stays mounted through the exit drop, so a
            // leaked click would skip the slab stage instantly
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="relative cursor-grab touch-none active:cursor-grabbing"
              style={{ width: PACK_W, height: PACK_H, perspective: '1100px' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <div
                ref={cylRef}
                className="absolute inset-0"
                style={{
                  transformStyle: 'preserve-3d',
                  transform: 'rotateY(0deg)',
                  willChange: 'transform',
                }}
              >
                {Array.from({ length: SLOTS }).map((_, i) => (
                  <div
                    key={i}
                    className="absolute inset-0"
                    style={{
                      transform: `rotateY(${i * STEP}deg) translateZ(${RADIUS}px)`,
                      backfaceVisibility: 'hidden',
                    }}
                  >
                    {/* idle float, measured off live: y ±2.1px over 4.4s, ease-in-out */}
                    <motion.div
                      className="absolute inset-0"
                      animate={reduced ? undefined : { y: [2.1, -2.1, 2.1] }}
                      transition={{
                        duration: 4.4,
                        ease: 'easeInOut',
                        repeat: Infinity,
                      }}
                    >
                      <Image
                        src={packImage}
                        alt={i === 0 ? packName : ''}
                        aria-hidden={i !== 0}
                        fill
                        sizes="(max-width: 640px) 60vw, 360px"
                        className="object-contain drop-shadow-[0_20px_36px_rgba(0,0,0,0.6)]"
                        draggable={false}
                      />
                      {/* floor reflection — pointer-events-none so the strip below the
                          pack can't swallow clicks meant for the Shuffle button */}
                      <div
                        className="pointer-events-none absolute left-0 top-full h-full w-full overflow-hidden opacity-20"
                        style={{
                          transform: 'scaleY(-1)',
                          maskImage:
                            'linear-gradient(to bottom, rgba(0,0,0,0.6), transparent 55%)',
                          WebkitMaskImage:
                            'linear-gradient(to bottom, rgba(0,0,0,0.6), transparent 55%)',
                        }}
                        aria-hidden
                      >
                        <Image
                          src={packImage}
                          alt=""
                          fill
                          sizes="(max-width: 640px) 60vw, 360px"
                          className="object-contain"
                          draggable={false}
                        />
                      </div>
                    </motion.div>
                  </div>
                ))}
              </div>
            </div>
            <motion.div
              className="flex flex-col items-center gap-3"
              exit={{
                opacity: 0,
                transition: { duration: 0.18, ease: EASE_TW },
              }}
            >
              <button
                type="button"
                onClick={shuffle}
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-5 py-2 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10"
              >
                ⇄ Shuffle
              </button>
              <p className="text-[11px] font-medium uppercase tracking-[0.25em] text-white/35">
                Drag to spin · tap a pack to open
              </p>
            </motion.div>
          </motion.div>
        )}

        {/* STAGE 2 — face-down graded slab RISES in (y 200→0, 0.6s ease(0.16,1,0.3,1),
            starting as the packs finish dropping) with a looping celestial shimmer */}
        {stage === 'slab' && (
          <motion.div
            key="slab"
            className="absolute inset-0 flex flex-col items-center justify-center gap-8"
            initial={reduced ? false : { y: 200, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.15, ease: EASE_TW } }}
            transition={{ ...SLAB_RISE, delay: 0.46 }}
          >
            <SlabBack shimmer={!reduced} />
            <motion.p
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, ease: 'easeOut', delay: 0.66 }}
              className="text-[11px] font-medium uppercase tracking-[0.3em] text-white/50 motion-safe:animate-pulse"
            >
              ● Tap to reveal
            </motion.p>
          </motion.div>
        )}

        {/* STAGE 3 — metadata suspense over clean black: rows pop in with overshoot
            (label y16/0.25s, value y12/0.2s, ease(0.34,1.56,0.64,1)) at 0.2/0.9/1.6s,
            rarity pill at 2.6s; auto-advances at ≈3.6s */}
        {stage === 'metadata' && (
          <motion.div
            key="metadata"
            className="absolute inset-0 flex flex-col items-center justify-center gap-7 text-center"
            exit={{ opacity: 0, transition: { duration: 0.15, ease: EASE_TW } }}
          >
            {rows.map((r, i) => (
              <MetaRow
                key={r.label}
                label={r.label}
                value={r.value}
                delay={
                  META_LABEL_DELAYS[i] ?? META_LABEL_DELAYS[2] + 0.7 * (i - 2)
                }
                reduced={reduced}
              />
            ))}
            <motion.div
              initial={reduced ? false : { y: 12, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{
                duration: 0.3,
                ease: EASE_BACK,
                delay: META_PILL_DELAY,
              }}
              className="mt-1"
            >
              <RarityPill rarity={card.rarity} rgb={rgb} />
            </motion.div>
          </motion.div>
        )}

        {/* STAGE 4 — rarity PULL celebration (top rarities only, like live):
            diagonal ribbon + shout over the still-visible slab */}
        {stage === 'pull' && (
          <motion.div
            key="pull"
            className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
            aria-hidden
            exit={{ opacity: 0, transition: { duration: 0.15, ease: EASE_TW } }}
          >
            <SlabBack faded />
            <div
              className="absolute left-1/2 top-1/2 w-[160%] -translate-x-1/2 -translate-y-1/2 overflow-hidden py-3 shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
              style={{
                background: `rgb(${rgb})`,
                animation: 'pullRibbonIn 0.5s cubic-bezier(0.2,0.8,0.2,1) both',
              }}
            >
              <div
                className="flex w-[200%] whitespace-nowrap"
                style={{ animation: 'pullMarquee 6s linear infinite' }}
              >
                {[0, 1].map((k) => (
                  <span
                    key={k}
                    className="flex w-1/2 justify-around text-2xl font-black uppercase tracking-tight text-black/70"
                  >
                    {Array.from({ length: 6 }).map((_, i) => (
                      <span key={i} className="px-4">
                        {card.rarity} Pull&nbsp;•
                      </span>
                    ))}
                  </span>
                ))}
              </div>
            </div>
            <p
              className="font-heading absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-5xl font-black uppercase tracking-tight text-white sm:text-7xl"
              style={{
                animation: 'pullShout 0.55s cubic-bezier(0.2,0.9,0.3,1) both',
                textShadow: '0 4px 24px rgba(0,0,0,0.6)',
              }}
            >
              {card.rarity}!
            </p>
          </motion.div>
        )}

        {/* STAGE 5 — the won card FLIPS in (rotateY 90→0, 0.6s ease(0.16,1,0.3,1),
            content fading 0.28s) over a spinning rarity glow; caption rises at +0.4s */}
        {stage === 'card' && (
          <motion.div
            key="card"
            className="absolute inset-0 flex flex-col items-center justify-center gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            {!reduced && (
              <div
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 h-[560px] w-[560px] blur-3xl"
                style={{
                  // centering lives INSIDE the keyframe (translate(-50%,-50%) rotate(...)) —
                  // Tailwind v4 translate-* utilities would double-shift on top of it.
                  background: `conic-gradient(from 0deg, rgba(${rgb},0.45), transparent 30%, rgba(${rgb},0.3) 50%, transparent 72%, rgba(${rgb},0.45))`,
                  borderRadius: '50%',
                  animation: 'glowSpin 3.5s linear infinite',
                }}
              />
            )}
            <motion.div
              initial={reduced ? false : { rotateY: 90, opacity: 0 }}
              animate={{ rotateY: 0, opacity: 1 }}
              transition={{
                ...CARD_FLIP,
                opacity: { duration: 0.28, ease: EASE_TW },
              }}
              style={{
                transformPerspective: 1000,
                filter: `drop-shadow(0 0 60px rgba(${rgb},0.55))`,
              }}
              className="relative"
            >
              {/* The card asset IS the graded-slab product photo — live shows it raw
                  (330×569 at 1440, no frame, no radius); wrapping it in extra holder
                  chrome double-framed it. */}
              <Image
                src={card.image}
                alt={card.name}
                width={330}
                height={569}
                className="h-[440px] w-auto object-contain sm:h-[560px]"
              />
              {/* Demo spins watermark the result — the card is theater, not a pull */}
              {!isReal && (
                <span
                  aria-hidden
                  className="font-heading pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rotate-[-18deg] rounded-xl border-[3px] border-white/45 px-6 py-2 text-5xl font-black uppercase tracking-[0.25em] text-white/50 sm:text-6xl"
                  style={{ textShadow: '0 2px 16px rgba(0,0,0,0.8)' }}
                >
                  Demo
                </span>
              )}
            </motion.div>
            <motion.div
              initial={reduced ? false : { y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.3, ease: 'easeOut', delay: 0.4 }}
              className="relative flex flex-col items-center gap-2 text-center"
            >
              <p className="max-w-[300px] px-2 text-[13px] font-semibold leading-snug text-white">
                {card.name}
              </p>
              <div className="flex items-center gap-2">
                <RarityPill rarity={card.rarity} rgb={rgb} small />
                <span className="text-[13px] text-white/70">
                  Value:{' '}
                  <span className="font-bold text-white">
                    {marketPriceMyr != null
                      ? rm(marketPriceMyr ?? 0)
                      : card.value}
                  </span>
                  {!isReal && ' · demo'}
                </span>
              </div>
              <div className="mt-3 flex flex-col items-center gap-2">
                {/* Anonymous DEMO spin: keep/sell is replaced by the sign-up
                    conversion CTA — nothing was recorded, nothing is claimable. */}
                {onSignUp && (
                  <>
                    <button
                      type="button"
                      onClick={onSignUp}
                      className="inline-flex h-12 w-[300px] items-center justify-center rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition-opacity hover:opacity-95"
                    >
                      Sign up to keep what you pull
                    </button>
                    <p className="max-w-[300px] text-center text-[11px] text-white/50">
                      Demo result — nothing is recorded or claimable. Real opens
                      vault every pull to your account.
                    </p>
                  </>
                )}
                {/* Real pull: sell now (instant while the window runs, flat
                    after) — both go through the confirm modal. Demo spins have
                    no offer. */}
                {buyback && sell.phase !== 'sold' && (
                  <>
                    <button
                      type="button"
                      onClick={() => setConfirmOpen(true)}
                      disabled={sell.phase === 'selling'}
                      className="inline-flex h-12 w-[300px] items-center justify-center rounded-xl border border-amber-400/60 bg-amber-400/10 text-sm font-bold text-amber-300 transition-colors hover:bg-amber-400/20 disabled:opacity-60"
                    >
                      {sell.phase === 'selling'
                        ? 'Selling…'
                        : sellExpired
                          ? `Sell for RM ${buyback.vaultAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${buyback.vaultPercent}%)`
                          : `Sell back for RM ${buyback.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${buyback.percent}%) · ${secondsLeft}s`}
                    </button>
                    <p className="max-w-[300px] text-center text-[11px] text-white/50">
                      {sellExpired
                        ? `Instant offer expired — this card is in your vault and sells at the flat ${buyback.vaultPercent}% rate.`
                        : `Or keep it: vaulted cards sell anytime at the flat ${buyback.vaultPercent}% rate.`}
                    </p>
                  </>
                )}
                {sell.phase === 'sold' && (
                  <p className="flex h-12 w-[300px] items-center justify-center rounded-xl border border-emerald-400/50 bg-emerald-400/10 text-sm font-bold text-emerald-300">
                    +RM{' '}
                    {sell.amount.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{' '}
                    credited · balance RM{' '}
                    {sell.balance.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </p>
                )}
                {sell.phase === 'error' && (
                  <p className="max-w-[300px] text-center text-[12px] font-medium text-red-400">
                    {sell.message}
                  </p>
                )}
                {/* The sign-up CTA owns the primary slot on anonymous demos —
                    Continue demotes to a quiet dismiss there. */}
                <button
                  type="button"
                  onClick={onClose}
                  className={
                    onSignUp
                      ? 'inline-flex h-10 items-center justify-center rounded-xl px-5 text-[13px] font-semibold text-white/60 transition-colors hover:text-white'
                      : 'inline-flex h-12 w-[300px] items-center justify-center rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition-opacity hover:opacity-95'
                  }
                >
                  {buyback && sell.phase !== 'sold' && !sellExpired
                    ? 'Keep in vault'
                    : 'Continue'}
                </button>
                <button
                  type="button"
                  onClick={onOpenAnother}
                  disabled={opening}
                  className="inline-flex h-10 items-center justify-center rounded-xl px-5 text-[13px] font-semibold text-white/60 transition-colors hover:text-white disabled:opacity-60"
                >
                  {opening
                    ? 'Opening…'
                    : isReal
                      ? 'Open another'
                      : 'Spin again'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {buyback && (
        <SellConfirmModal
          open={confirmOpen}
          cardName={card.name}
          image={card.image}
          fmv={buyback.fmv}
          rateType={sellExpired ? 'flat' : 'instant'}
          percent={sellExpired ? buyback.vaultPercent : buyback.percent}
          netCredit={sellExpired ? buyback.vaultAmount : buyback.amount}
          secondsLeft={sellExpired ? undefined : secondsLeft}
          busy={sell.phase === 'selling'}
          onConfirm={handleSellBack}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

// One metadata row: tiny grey label over a big glowing value (live: 42px), both
// popping up with the measured overshoot ease, value trailing its label by 100ms.
function MetaRow({
  label,
  value,
  delay,
  reduced,
}: {
  label: string;
  value: string;
  delay: number;
  reduced: boolean;
}) {
  return (
    <div>
      <motion.p
        initial={reduced ? false : { y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.25, ease: EASE_BACK, delay }}
        className="text-[10px] font-medium uppercase tracking-[0.3em] text-white/35"
      >
        {label}
      </motion.p>
      <motion.p
        initial={reduced ? false : { y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{
          duration: 0.2,
          ease: EASE_BACK,
          delay: delay + META_VALUE_OFFSET,
        }}
        className="font-heading mt-1 text-3xl font-bold text-white sm:text-[42px] sm:leading-tight"
        style={{ textShadow: '0 0 24px rgba(255,255,255,0.25)' }}
      >
        {value}
      </motion.p>
    </div>
  );
}

function RarityPill({
  rarity,
  rgb,
  small,
}: {
  rarity: PackCard['rarity'];
  rgb: string;
  small?: boolean;
}) {
  return (
    <span
      className={
        small
          ? 'rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider'
          : 'rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-widest'
      }
      style={
        {
          background: `rgba(${rgb},0.18)`,
          color: `rgb(${rgb})`,
          border: `1px solid rgba(${rgb},0.5)`,
        } as CSSProperties
      }
    >
      {rarity}
    </span>
  );
}

// Face-down graded slab back (pokenic-branded) — a clear holder bezel, a top label
// (wordmark + QR), embossed category glyphs over black, and a certification footer.
// `shimmer` adds live's looping celestial sweep across the face (6.5s ease-in-out).
function SlabBack({ faded, shimmer }: { faded?: boolean; shimmer?: boolean }) {
  return (
    <div
      className={`relative h-[400px] w-[290px] rounded-[20px] border border-white/10 bg-gradient-to-b from-neutral-700/60 to-neutral-950 p-2.5 shadow-[0_30px_60px_-12px_rgba(0,0,0,0.8)] ${faded ? 'opacity-60' : ''}`}
    >
      {/* inner card back */}
      <div className="relative flex h-full w-full flex-col overflow-hidden rounded-xl bg-gradient-to-b from-neutral-900 to-black ring-1 ring-white/5">
        {/* top label: wordmark + QR */}
        <div className="m-2 flex items-center justify-between rounded-md bg-white/5 px-3 py-2">
          <span className="font-heading text-sm font-bold tracking-tight text-white/85">
            pokenic
          </span>
          <span
            className="grid h-7 w-7 grid-cols-4 grid-rows-4 gap-px overflow-hidden rounded-sm bg-white p-0.5"
            aria-hidden
          >
            {Array.from({ length: 16 }).map((_, i) => (
              <span
                key={i}
                className={
                  [0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15, 5, 10].includes(i)
                    ? 'bg-black'
                    : 'bg-transparent'
                }
              />
            ))}
          </span>
        </div>
        {/* embossed glyph field */}
        <div className="relative flex-1">
          <span className="font-heading absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-6xl font-black text-white/15">
            P
          </span>
          <span
            className="absolute right-7 top-6 h-7 w-7 rounded-full border-2 border-white/10"
            aria-hidden
          />
          <span
            className="absolute bottom-10 left-8 h-7 w-7 rounded-full border-2 border-white/10"
            aria-hidden
          >
            <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/10" />
          </span>
          <span
            className="absolute bottom-8 right-9 h-6 w-6 rounded-full border-2 border-white/10"
            aria-hidden
          >
            <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-white/10" />
          </span>
        </div>
        <p className="pb-3 text-center text-[8px] uppercase tracking-[0.3em] text-white/25">
          Phygital Certification
        </p>
        {/* celestial shimmer sweep (live `revealv4-celestial-sweep`, 6.5s loop) */}
        {shimmer && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-[-20%] w-[55%] motion-safe:animate-[celestialSweep_6.5s_ease-in-out_infinite]"
            style={{
              background:
                'linear-gradient(105deg, transparent 0%, rgba(255,255,255,0.09) 38%, rgba(255,255,255,0.22) 50%, rgba(255,255,255,0.09) 62%, transparent 100%)',
            }}
          />
        )}
      </div>
    </div>
  );
}
