"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ArrowRight, X } from "lucide-react";
import type { PackCard } from "../packs-data";

// Rarity → rgb (shared with the detail page's rings) drives the glow/burst color.
const RARITY_RGB: Record<PackCard["rarity"], string> = {
  Legendary: "234, 179, 8",
  Epic: "217, 70, 239",
  Rare: "56, 189, 248",
  Uncommon: "52, 211, 153",
  Common: "163, 163, 163",
};

// Burst intensity scales with rarity — a Legendary celebrates harder than a Common.
const SHARD_COUNT: Record<PackCard["rarity"], number> = {
  Legendary: 30,
  Epic: 24,
  Rare: 18,
  Uncommon: 13,
  Common: 10,
};

type Stage = "charge" | "burst" | "card" | "done";

const T_CHARGE = 950; // pack charges up
const T_BURST = 480; // flash + shards

// The full-screen pack-opening reveal: the pack drops in and charges, bursts in a
// rarity-colored shower, then the won card flips in. Under reduced motion it skips
// straight to the card. Driven by the real backend-won card (or a demo card).
export default function PackOpenOverlay({
  card,
  isReal,
  packImage,
  packName,
  opening,
  reduced,
  onClose,
  onOpenAnother,
}: {
  card: PackCard;
  isReal: boolean;
  packImage: string;
  packName: string;
  opening: boolean;
  reduced: boolean;
  onClose: () => void;
  onOpenAnother: () => void;
}) {
  const [stage, setStage] = useState<Stage>(reduced ? "done" : "charge");
  const rgb = RARITY_RGB[card.rarity];
  const revealed = stage === "done" || reduced;

  // Per-shard outward vectors — computed once per reveal. Client-only (the overlay
  // mounts on interaction, never during SSR), so Math.random is safe here.
  const shards = useMemo(() => {
    const n = SHARD_COUNT[card.rarity];
    return Array.from({ length: n }, (_, i) => {
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 90 + Math.random() * 160;
      return {
        tx: Math.cos(angle) * dist,
        ty: Math.sin(angle) * dist,
        size: 5 + Math.random() * 8,
        delay: Math.random() * 90,
        dur: 480 + Math.random() * 340,
      };
    });
  }, [card]);

  // Stage machine (skipped under reduced motion).
  useEffect(() => {
    if (reduced) return;
    const timers = [
      setTimeout(() => setStage("burst"), T_CHARGE),
      setTimeout(() => setStage("card"), T_CHARGE + 120),
      setTimeout(() => setStage("done"), T_CHARGE + T_BURST + 650),
    ];
    return () => timers.forEach(clearTimeout);
  }, [reduced]);

  // Escape closes once the card is revealed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && revealed) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, onClose]);

  const showCharge = stage === "charge";
  const showBurst = stage === "burst" || stage === "card";
  const showCard = stage === "card" || revealed;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm motion-safe:animate-[fadeIn_0.3s_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-label={`You pulled ${card.name}`}
      onClick={() => revealed && onClose()}
    >
      {revealed && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      )}

      <div className="relative flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
        {/* Ambient rarity glow behind the whole stage */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[440px] w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
          style={{
            background: `radial-gradient(circle, rgba(${rgb},0.45) 0%, rgba(${rgb},0) 70%)`,
            animation: reduced ? undefined : "auraPulse 2.4s ease-in-out infinite",
          }}
        />

        {/* STAGE: charge — the pack to be opened */}
        {showCharge && (
          <div className="relative" style={{ animation: "packCharge 0.95s cubic-bezier(0.2,0.7,0.2,1) both" }}>
            <div aria-hidden className="absolute inset-0 -z-10 rounded-2xl blur-2xl" style={{ background: `rgba(${rgb},0.5)` }} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={packImage} alt={packName} className="h-48 w-auto object-contain drop-shadow-2xl sm:h-56" />
          </div>
        )}

        {/* STAGE: burst — flash + shockwave ring + shards */}
        {showBurst && (
          <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <div
              className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                background: `radial-gradient(circle, #fff 0%, rgba(${rgb},0.9) 35%, rgba(${rgb},0) 70%)`,
                animation: "revealFlash 0.5s ease-out forwards",
              }}
            />
            <div
              className="absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
              style={{ borderColor: `rgba(${rgb},0.8)`, animation: "revealRing 0.55s ease-out forwards" }}
            />
            {shards.map((s, i) => (
              <span
                key={i}
                className="absolute left-1/2 top-1/2 rounded-full"
                style={
                  {
                    width: s.size,
                    height: s.size,
                    marginLeft: -s.size / 2,
                    marginTop: -s.size / 2,
                    background: `rgb(${rgb})`,
                    boxShadow: `0 0 8px rgba(${rgb},0.85)`,
                    "--tx": `${s.tx}px`,
                    "--ty": `${s.ty}px`,
                    animation: `shardFly ${s.dur}ms ease-out ${s.delay}ms forwards`,
                  } as CSSProperties
                }
              />
            ))}
          </div>
        )}

        {/* STAGE: card — the won card */}
        {showCard && (
          <div
            className="flex flex-col items-center"
            style={{ animation: reduced ? undefined : "cardReveal 0.6s cubic-bezier(0.2,0.8,0.2,1) both" }}
          >
            <div
              className="overflow-hidden rounded-2xl border-2 bg-neutral-900 p-2"
              style={{ borderColor: `rgba(${rgb},0.85)`, boxShadow: `0 0 50px -6px rgba(${rgb},0.7)` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={card.image}
                alt={card.name}
                className="h-[300px] w-[225px] rounded-lg object-contain sm:h-[360px] sm:w-[270px]"
              />
            </div>
          </div>
        )}

        {/* Caption + actions, after the card lands */}
        {revealed && (
          <div
            className="mt-6 flex flex-col items-center gap-3 text-center"
            style={{ animation: reduced ? undefined : "captionUp 0.45s ease-out both" }}
          >
            <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-white/45">
              You pulled{!isReal && " · demo"}
            </p>
            <p className="font-heading max-w-md px-4 text-xl font-bold text-white sm:text-2xl">{card.name}</p>
            <p className="text-sm font-semibold" style={{ color: `rgb(${rgb})` }}>
              {card.rarity} · {card.value}
            </p>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={onOpenAnother}
                disabled={opening}
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 px-5 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition-opacity hover:opacity-95 disabled:opacity-60"
              >
                {opening ? "Opening…" : "Open another"}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-11 items-center justify-center rounded-xl border border-white/15 bg-white/5 px-5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
