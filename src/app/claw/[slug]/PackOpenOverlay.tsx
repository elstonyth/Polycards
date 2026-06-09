"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ArrowLeft, Zap, Volume2 } from "lucide-react";
import type { PackCard } from "../packs-data";

// Rarity → rgb (shared with the detail-page rings) drives the glow, pill, and the
// Pull-celebration ribbon color.
const RARITY_RGB: Record<PackCard["rarity"], string> = {
  Legendary: "234, 179, 8",
  Epic: "217, 70, 239",
  Rare: "56, 189, 248",
  Uncommon: "52, 211, 153",
  Common: "163, 163, 163",
};

// Carousel cylinder geometry, measured from the live phygitals demo (6 packs 60°
// apart, radius≈259 at a 318px pack; scaled down here, same ratio). See
// docs/research/components/pack-opening.spec.md.
const SLOTS = 6;
const STEP = 360 / SLOTS; // 60°
const PACK_W = 196;
const PACK_H = 304;
const RADIUS = 188;
const DRAG_DEG_PER_PX = 0.4;

type Stage = "packs" | "slab" | "metadata" | "pull" | "card";

// Full-screen pack-opening, frame-matched to the live phygitals flow: an interactive
// 3D pack cylinder (drag/swipe to spin, shuffle, tap to select) → a face-down graded
// slab → metadata → a rarity "PULL" celebration → the won card in a graded holder.
// Reduced motion jumps straight to the card.
export default function PackOpenOverlay({
  card,
  isReal,
  packImage,
  packName,
  category,
  reduced,
  opening,
  onClose,
  onOpenAnother,
}: {
  card: PackCard;
  isReal: boolean;
  packImage: string;
  packName: string;
  category: string;
  reduced: boolean;
  opening: boolean;
  onClose: () => void;
  onOpenAnother: () => void;
}) {
  const [stage, setStage] = useState<Stage>(reduced ? "card" : "packs");
  const rgb = RARITY_RGB[card.rarity];

  // GRADE parsed from the card name (e.g. "… PSA 10", "… CGC 9.5"); shown in metadata
  // only when present — never fabricated.
  const gradeMatch = card.name.match(/\b(PSA|CGC|BGS|SGC)\s*(\d+(?:\.\d+)?)\b/i);
  const gradeLabel = gradeMatch ? `${gradeMatch[1].toUpperCase()} ${gradeMatch[2]}` : null;

  // Interactive cylinder driven IMPERATIVELY (ref + direct style writes) so dragging
  // never re-renders the 12 pack images — React state on every pointermove was the lag.
  const cylRef = useRef<HTMLDivElement>(null);
  const rotRef = useRef(0);
  const drag = useRef({ active: false, startX: 0, startRot: 0, moved: false });

  const applyRotation = (deg: number, animate: boolean) => {
    const el = cylRef.current;
    if (!el) return;
    el.style.transition = animate ? "transform 0.6s cubic-bezier(0.22,0.61,0.36,1)" : "none";
    el.style.transform = `rotateY(${deg}deg)`;
    rotRef.current = deg;
  };

  // metadata holds, then the Pull celebration, then the card.
  useEffect(() => {
    if (stage === "metadata") {
      const t = setTimeout(() => setStage("pull"), 1800);
      return () => clearTimeout(t);
    }
    if (stage === "pull") {
      const t = setTimeout(() => setStage("card"), 1150);
      return () => clearTimeout(t);
    }
  }, [stage]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (stage !== "packs") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { active: true, startX: e.clientX, startRot: rotRef.current, moved: false };
    if (cylRef.current) cylRef.current.style.transition = "none";
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current.active || !cylRef.current) return;
    const dx = e.clientX - drag.current.startX;
    if (Math.abs(dx) > 6) drag.current.moved = true;
    const deg = drag.current.startRot + dx * DRAG_DEG_PER_PX;
    cylRef.current.style.transform = `rotateY(${deg}deg)`; // imperative — no re-render
    rotRef.current = deg;
  };
  const onPointerUp = () => {
    if (!drag.current.active) return;
    const { moved } = drag.current;
    drag.current.active = false;
    if (!moved) setStage("slab"); // a tap (not a drag) → reveal
    else applyRotation(Math.round(rotRef.current / STEP) * STEP, true); // snap to slot
  };

  const shuffle = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const target =
      Math.round(rotRef.current / STEP) * STEP + 360 * 2 + STEP * (1 + Math.floor(Math.random() * (SLOTS - 1)));
    applyRotation(target, true);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center overflow-hidden bg-black motion-safe:animate-[fadeIn_0.3s_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-label={`Opening ${packName}`}
      onClick={() => {
        // Tap-to-advance: reveal the slab, then step through metadata → pull →
        // card on demand instead of waiting out the auto-play timers (taps were
        // previously swallowed, so the reveal felt stuck with "no card").
        if (stage === "slab") setStage("metadata");
        else if (stage === "metadata") setStage("pull");
        else if (stage === "pull") setStage("card");
      }}
    >
      {/* top bar */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
        className="absolute left-4 top-4 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      >
        <ArrowLeft className="h-5 w-5" aria-hidden />
      </button>
      <div className="absolute right-4 top-4 z-20 flex gap-2 text-white/40">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5"><Zap className="h-4 w-4" aria-hidden /></span>
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5"><Volume2 className="h-4 w-4" aria-hidden /></span>
      </div>
      {stage !== "packs" && (
        <p className="absolute top-5 left-1/2 z-20 -translate-x-1/2 text-[11px] font-medium uppercase tracking-[0.3em] text-white/35">1 of 1</p>
      )}
      {/* Tap-to-continue hint during the auto-playing reveal stages */}
      {(stage === "metadata" || stage === "pull") && (
        <p className="pointer-events-none absolute bottom-10 left-1/2 z-20 -translate-x-1/2 text-[11px] font-medium uppercase tracking-[0.3em] text-white/35 motion-safe:animate-pulse">
          ● Tap to continue
        </p>
      )}

      {/* ambient rarity glow (reveal stages) */}
      {(stage === "metadata" || stage === "pull" || stage === "card") && (
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
          style={{ background: `radial-gradient(circle, rgba(${rgb},0.4) 0%, rgba(${rgb},0) 70%)`, animation: reduced ? undefined : "auraPulse 2.6s ease-in-out infinite" }} />
      )}

      {/* STAGE 1 — interactive 3D pack cylinder */}
      {stage === "packs" && (
        <div className="flex select-none flex-col items-center gap-12">
          <div
            className="relative cursor-grab touch-none active:cursor-grabbing"
            style={{ width: PACK_W, height: PACK_H, perspective: "1100px" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div
              ref={cylRef}
              className="absolute inset-0"
              style={{
                transformStyle: "preserve-3d",
                transform: "rotateY(0deg)",
                willChange: "transform",
              }}
            >
              {Array.from({ length: SLOTS }).map((_, i) => (
                <div
                  key={i}
                  className="absolute inset-0"
                  style={{ transform: `rotateY(${i * STEP}deg) translateZ(${RADIUS}px)`, backfaceVisibility: "hidden" }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={packImage} alt={i === 0 ? packName : ""} aria-hidden={i !== 0}
                    className="h-full w-full object-contain drop-shadow-[0_20px_36px_rgba(0,0,0,0.6)]" draggable={false} />
                  {/* floor reflection */}
                  <div className="absolute left-0 top-full h-full w-full overflow-hidden opacity-20" style={{ transform: "scaleY(-1)", maskImage: "linear-gradient(to bottom, rgba(0,0,0,0.6), transparent 55%)", WebkitMaskImage: "linear-gradient(to bottom, rgba(0,0,0,0.6), transparent 55%)" }} aria-hidden>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={packImage} alt="" className="h-full w-full object-contain" draggable={false} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={shuffle}
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-5 py-2 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10"
            >
              ⇄ Shuffle
            </button>
            <p className="text-[11px] font-medium uppercase tracking-[0.25em] text-white/35">Drag to spin · tap a pack to open</p>
          </div>
        </div>
      )}

      {/* STAGE 2 — face-down graded slab */}
      {stage === "slab" && (
        <div className="flex flex-col items-center gap-8 motion-safe:animate-[cardReveal_0.5s_cubic-bezier(0.2,0.8,0.2,1)_both]">
          <SlabBack />
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-white/45 motion-safe:animate-pulse">● Tap to reveal</p>
        </div>
      )}

      {/* STAGE 3 — metadata */}
      {stage === "metadata" && (
        <div className="flex flex-col items-center gap-5 text-center">
          <Meta label="Category" value={category} delay={0} />
          {gradeLabel && <Meta label="Grade" value={gradeLabel} delay={150} />}
          <Meta label="Value" value={card.value} delay={gradeLabel ? 300 : 150} />
          <div style={{ animation: "metaUp 0.5s ease-out 0.42s both" }}>
            <RarityPill rarity={card.rarity} rgb={rgb} />
          </div>
        </div>
      )}

      {/* STAGE 4 — rarity PULL celebration (diagonal ribbon + shout) */}
      {stage === "pull" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden" aria-hidden onClick={(e) => e.stopPropagation()}>
          <SlabBack faded />
          <div
            className="absolute left-1/2 top-1/2 w-[160%] -translate-x-1/2 -translate-y-1/2 overflow-hidden py-3 shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
            style={{ background: `rgb(${rgb})`, animation: "pullRibbonIn 0.5s cubic-bezier(0.2,0.8,0.2,1) both" }}
          >
            <div className="flex w-[200%] whitespace-nowrap" style={{ animation: "pullMarquee 6s linear infinite" }}>
              {[0, 1].map((k) => (
                <span key={k} className="flex w-1/2 justify-around text-2xl font-black uppercase tracking-tight text-black/70">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <span key={i} className="px-4">{card.rarity} Pull&nbsp;•</span>
                  ))}
                </span>
              ))}
            </div>
          </div>
          <p
            className="font-heading absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-5xl font-black uppercase tracking-tight text-white sm:text-7xl"
            style={{ animation: "pullShout 0.55s cubic-bezier(0.2,0.9,0.3,1) both", textShadow: "0 4px 24px rgba(0,0,0,0.6)" }}
          >
            {card.rarity}!
          </p>
        </div>
      )}

      {/* STAGE 5 — the won card in a graded holder */}
      {stage === "card" && (
        <div className="flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
          <div
            className="motion-safe:animate-[cardReveal_0.6s_cubic-bezier(0.2,0.8,0.2,1)_both]"
            style={{ filter: `drop-shadow(0 0 60px rgba(${rgb},0.6))` }}
          >
            <GradedHolder image={card.image} name={card.name} grade={gradeLabel} category={category} rgb={rgb} />
          </div>
          <div className="flex flex-col items-center gap-2 text-center" style={{ animation: reduced ? undefined : "captionUp 0.45s ease-out 0.15s both" }}>
            <p className="font-heading max-w-md px-4 text-sm font-bold text-white sm:text-base">{card.name}</p>
            <div className="flex items-center gap-2">
              <RarityPill rarity={card.rarity} rgb={rgb} small />
              <span className="text-[13px] font-semibold text-white/70">Value: {card.value}{!isReal && " · demo"}</span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button type="button" onClick={onClose} className="inline-flex h-11 items-center justify-center rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 px-7 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition-opacity hover:opacity-95">
                Continue
              </button>
              <button type="button" onClick={onOpenAnother} disabled={opening} className="inline-flex h-11 items-center justify-center rounded-xl border border-white/15 bg-white/5 px-5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:opacity-60">
                {opening ? "Opening…" : "Open another"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value, delay }: { label: string; value: string; delay: number }) {
  return (
    <div style={{ animation: `metaUp 0.5s ease-out ${delay}ms both` }}>
      <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-white/35">{label}</p>
      <p className="font-heading mt-1 text-2xl font-bold text-white sm:text-3xl" style={{ textShadow: "0 0 24px rgba(255,255,255,0.25)" }}>{value}</p>
    </div>
  );
}

function RarityPill({ rarity, rgb, small }: { rarity: PackCard["rarity"]; rgb: string; small?: boolean }) {
  return (
    <span
      className={small ? "rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider" : "rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-widest"}
      style={{ background: `rgba(${rgb},0.18)`, color: `rgb(${rgb})`, border: `1px solid rgba(${rgb},0.5)` } as CSSProperties}
    >
      {rarity}
    </span>
  );
}

// Face-down graded slab back (pokenic-branded) — a clear holder bezel, a top label
// (wordmark + QR), embossed category glyphs over black, and a certification footer.
function SlabBack({ faded }: { faded?: boolean }) {
  return (
    <div className={`relative h-[400px] w-[290px] rounded-[20px] border border-white/10 bg-gradient-to-b from-neutral-700/60 to-neutral-950 p-2.5 shadow-[0_30px_60px_-12px_rgba(0,0,0,0.8)] ${faded ? "opacity-60" : ""}`}>
      {/* inner card back */}
      <div className="relative flex h-full w-full flex-col rounded-xl bg-gradient-to-b from-neutral-900 to-black ring-1 ring-white/5">
        {/* top label: wordmark + QR */}
        <div className="m-2 flex items-center justify-between rounded-md bg-white/5 px-3 py-2">
          <span className="font-heading text-sm font-bold tracking-tight text-white/85">pokenic</span>
          <span className="grid h-7 w-7 grid-cols-4 grid-rows-4 gap-px overflow-hidden rounded-sm bg-white p-0.5" aria-hidden>
            {Array.from({ length: 16 }).map((_, i) => (
              <span key={i} className={[0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15, 5, 10].includes(i) ? "bg-black" : "bg-transparent"} />
            ))}
          </span>
        </div>
        {/* embossed glyph field */}
        <div className="relative flex-1">
          <span className="font-heading absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-6xl font-black text-white/15">P</span>
          <span className="absolute right-7 top-6 h-7 w-7 rounded-full border-2 border-white/10" aria-hidden />
          <span className="absolute bottom-10 left-8 h-7 w-7 rounded-full border-2 border-white/10" aria-hidden>
            <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/10" />
          </span>
          <span className="absolute bottom-8 right-9 h-6 w-6 rounded-full border-2 border-white/10" aria-hidden>
            <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-white/10" />
          </span>
        </div>
        <p className="pb-3 text-center text-[8px] uppercase tracking-[0.3em] text-white/25">Phygital Certification</p>
      </div>
    </div>
  );
}

// The revealed card inside a PSA-style graded holder (white frame + top grade label).
function GradedHolder({ image, name, grade, category, rgb }: { image: string; name: string; grade: string | null; category: string; rgb: string }) {
  return (
    <div className="rounded-2xl border-2 bg-neutral-100 p-2 shadow-2xl" style={{ borderColor: `rgba(${rgb},0.85)` }}>
      <div className="rounded-lg bg-white p-1.5">
        {/* slim top cert label */}
        <div className="mb-1.5 flex items-center justify-between rounded-sm bg-neutral-900 px-2 py-1 text-white">
          <span className="text-[8px] font-bold uppercase tracking-wide text-white/80">{category}</span>
          {grade && <span className="rounded-sm bg-red-600 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide">{grade}</span>}
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt={name} className="h-[300px] w-[222px] rounded object-contain sm:h-[356px] sm:w-[264px]" />
      </div>
    </div>
  );
}
