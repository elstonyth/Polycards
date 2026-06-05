"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Clock,
  Flame,
  Info,
  Minus,
  Play,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-reveal";
import Reveal from "@/components/Reveal";
import {
  type Pack,
  type ResolvedPack,
  type PackCard,
  CARD_POOL,
  ODDS,
  clawMachine,
  priceNumber,
} from "../packs-data";

// Roulette item width (px) — kept in JS so the landing offset is exact.
const ITEM_W = 116;
const WIN_INDEX = 36; // strip lands on this index

const RARITY_RING: Record<PackCard["rarity"], string> = {
  Legendary: "234, 179, 8",
  Epic: "217, 70, 239",
  Rare: "56, 189, 248",
  Uncommon: "52, 211, 153",
  Common: "163, 163, 163",
};

// Spice level changes the live-odds distribution (Mild = safe, Hot = high variance).
const SPICE_LEVELS = ["Mild", "Medium", "Hot"] as const;
type Spice = (typeof SPICE_LEVELS)[number];
const SPICE_ICON: Record<Spice, string> = { Mild: "🌶️", Medium: "🌶️🌶️", Hot: "🌶️🌶️🌶️" };
const SPICE_MULT: Record<Spice, number> = { Mild: 0.98, Medium: 1, Hot: 1.04 };

// Live odds = value-range → probability, matching the live site's panel (mock).
const LIVE_ODDS: Record<Spice, { range: string; pct: string }[]> = {
  Mild: [
    { range: "$0 – $50", pct: "68%" },
    { range: "$50 – $250", pct: "26%" },
    { range: "$250 – $1,000", pct: "5%" },
    { range: "$1,000 – $5,000", pct: "1%" },
  ],
  Medium: [
    { range: "$0 – $100", pct: "52%" },
    { range: "$100 – $500", pct: "32%" },
    { range: "$500 – $2,000", pct: "12%" },
    { range: "$2,000 – $8,000", pct: "4%" },
  ],
  Hot: [
    { range: "$0 – $250", pct: "34%" },
    { range: "$250 – $1,000", pct: "36%" },
    { range: "$1,000 – $10,000", pct: "22%" },
    { range: "$10,000+", pct: "8%" },
  ],
};

function CardThumb({ card, w }: { card: PackCard; w?: number }) {
  return (
    <div className="shrink-0 px-1" style={w ? { width: w } : undefined}>
      <div
        className="overflow-hidden rounded-xl border bg-neutral-900 p-1.5"
        style={{
          borderColor: `rgba(${RARITY_RING[card.rarity]},0.55)`,
          boxShadow: `0 0 16px -8px rgba(${RARITY_RING[card.rarity]},0.6)`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={card.image} alt={card.name} loading="lazy" className="aspect-[3/4] w-full rounded-md object-contain" />
      </div>
    </div>
  );
}

export default function PackDetailClient({
  pack,
  siblings,
}: {
  pack: ResolvedPack;
  siblings: Pack[];
}) {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState<Pack>(pack);
  const [qty, setQty] = useState(1);
  const [spice, setSpice] = useState<Spice>("Medium");
  const [phase, setPhase] = useState<"idle" | "spinning" | "done">("idle");
  const [offset, setOffset] = useState(0);
  const [won, setWon] = useState<PackCard | null>(null);
  const windowRef = useRef<HTMLDivElement>(null);

  const claw = clawMachine(active);
  const priceNum = priceNumber(active.price);
  // Expected value ≈ price, lifted slightly for boosted tiers / hotter spice (mock).
  const ev = Math.round(priceNum * (active.boost ? 1.02 : 0.96) * SPICE_MULT[spice]);
  const points = priceNum * 100 * qty;

  // Deterministic strip (SSR-safe order); the winner index is chosen on click.
  const strip = useMemo(
    () => Array.from({ length: 48 }, (_, i) => CARD_POOL[(i * 3 + 1) % CARD_POOL.length]),
    [],
  );
  const topHits = useMemo(
    () => [...CARD_POOL].sort((a, b) => priceNumber(b.value) - priceNumber(a.value)).slice(0, 5),
    [],
  );

  const setQ = (n: number) => setQty(Math.min(99, Math.max(1, n)));

  function spin() {
    if (phase === "spinning") return;
    const winner = strip[WIN_INDEX];
    if (reduced) {
      setWon(winner);
      setPhase("done");
      return;
    }
    setWon(null);
    setOffset(0);
    setPhase("spinning");
    const win = windowRef.current?.clientWidth ?? 600;
    const target = WIN_INDEX * ITEM_W + ITEM_W / 2 - win / 2;
    const jitter = (WIN_INDEX % 2 === 0 ? 1 : -1) * (ITEM_W * 0.18);
    requestAnimationFrame(() => requestAnimationFrame(() => setOffset(-(target + jitter))));
  }

  function reset() {
    setPhase("idle");
    setWon(null);
    setOffset(0);
  }

  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* Back link */}
      <Link
        href="/claw"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All packs
      </Link>

      {/* ===== MAIN: claw machine (left) + configurator (right) ===== */}
      <div className="grid items-start gap-6 lg:grid-cols-[1.55fr_1fr]">
        {/* ---- LEFT column ---- */}
        <div className="flex flex-col gap-6">
          {/* Claw machine stage */}
          <div className="relative flex aspect-[36/25] items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-zinc-200 to-zinc-400">
            {active.boost && (
              <span className="absolute left-4 top-4 z-20 rounded-md bg-emerald-500 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
                +90% Buyback Boost
              </span>
            )}
            {/* soft themed glow behind the machine */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-0 motion-safe:animate-[clawGlow_5s_ease-in-out_infinite]"
              style={{ background: "radial-gradient(45% 45% at 50% 45%, rgba(255,255,255,0.9), transparent 70%)" }}
            />
            {/* Claw-machine render. Like the live site this is an ANIMATED AVIF (the claw slides
                left↔right INSIDE the file) rendered in a FIXED <img> — no whole-image float. The full
                Pokenic rebrand is baked frame-by-frame into the asset: the banner wordmark, the
                placard ("pokenic claw.") and the base url ("pokenic.com"). Packs without an animated
                source fall back to the static rebranded webp. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={active.id}
              src={claw.anim ?? claw.webp}
              alt={`${active.name} claw machine`}
              className="relative z-10 h-full w-full object-contain"
            />
          </div>

          {/* Reveal stage — mock roulette (appears after Open / demo spin) */}
          {phase !== "idle" && (
            <section className="overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 p-5 sm:p-6">
              <div className="relative" ref={windowRef}>
                <div className="pointer-events-none absolute left-1/2 top-0 z-10 h-full w-0.5 -translate-x-1/2 bg-white/70" />
                <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 border-x-[6px] border-t-[8px] border-x-transparent border-t-white/70" />
                <div className="overflow-hidden">
                  <div
                    className={cn("flex", phase === "spinning" && "transition-transform duration-[4200ms] ease-[cubic-bezier(0.12,0.8,0.18,1)]")}
                    style={{ transform: `translateX(${offset}px)` }}
                    onTransitionEnd={() => {
                      if (phase === "spinning") {
                        setWon(strip[WIN_INDEX]);
                        setPhase("done");
                      }
                    }}
                  >
                    {strip.map((c, i) => (
                      <CardThumb key={i} card={c} w={ITEM_W} />
                    ))}
                  </div>
                </div>
              </div>
              {phase === "done" && won && (
                <div className="mt-5 flex flex-col items-center gap-2 text-center motion-safe:animate-[fadeIn_0.4s_ease-out]">
                  <p className="text-[11px] font-medium uppercase tracking-widest text-white/40">You pulled</p>
                  <p className="font-heading text-xl font-bold text-white">{won.name}</p>
                  <p className="text-sm" style={{ color: `rgb(${RARITY_RING[won.rarity]})` }}>
                    {won.rarity} · {won.value}
                  </p>
                  <button type="button" onClick={spin} className="mt-2 inline-flex h-10 items-center justify-center rounded-xl bg-neutral-200 px-5 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white">
                    Open another
                  </button>
                </div>
              )}
            </section>
          )}

          {/* Top Hits */}
          <Reveal as="section">
            <div className="mb-1 flex items-center gap-2">
              <Flame className="h-4 w-4 text-amber-400" aria-hidden />
              <h2 className="font-heading text-lg font-bold tracking-tight text-white">Top Hits</h2>
            </div>
            <p className="mb-3 text-[13px] text-white/45">The top items available in this pack.</p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              {topHits.map((c) => (
                <div key={c.id} className="flex flex-col gap-1.5">
                  <CardThumb card={c} />
                  <p className="truncate text-center text-[11px] font-medium text-white/70" title={c.name}>{c.value}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>

        {/* ---- RIGHT column: configurator ---- */}
        <aside className="lg:sticky lg:top-20">
          <div className="flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
            {/* Title + buyback */}
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
              <h1 className="font-heading text-xl font-bold tracking-tight text-white sm:text-2xl">{active.name}</h1>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/90 px-2.5 py-1 text-[11px] font-bold text-white">
                90% Buyback
                <Info className="h-3 w-3 opacity-80" aria-hidden />
              </span>
            </div>

            <div className="flex flex-col gap-5 overflow-y-auto px-5 py-5">
              {/* Category */}
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">Category</p>
                <div className="flex h-11 items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-white">
                  <span className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pack.icon} alt="" aria-hidden className="h-5 w-5 object-contain" />
                    {pack.categoryName}
                  </span>
                  <ChevronDown className="h-4 w-4 text-white/40" aria-hidden />
                </div>
              </div>

              {/* Pack tiles */}
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">Pack</p>
                <div className="grid grid-cols-2 gap-2">
                  {siblings.map((p) => {
                    const selected = p.id === active.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setActive(p);
                          reset();
                        }}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-center transition-colors",
                          selected
                            ? "border-white/40 bg-white/10"
                            : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]",
                        )}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.image} alt="" aria-hidden className="h-10 w-auto object-contain" />
                        <span className="text-[11px] font-medium leading-tight text-white">{p.name.replace(" Pack", "")}</span>
                        <span className="text-[11px] font-semibold text-white/55">{p.price}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Expected value */}
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-white/70">
                  Expected Value
                  <Info className="h-3.5 w-3.5 text-white/30" aria-hidden />
                </span>
                <span className="text-sm font-semibold text-white">
                  ${ev.toLocaleString("en-US")}
                  <span className="ml-1 text-[11px] font-normal text-white/40">per pack</span>
                </span>
              </div>

              {/* Spice level */}
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">
                  Select Spice Level
                  <Info className="h-3 w-3 text-white/25" aria-hidden />
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {SPICE_LEVELS.map((s) => {
                    const selected = s === spice;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSpice(s)}
                        aria-pressed={selected}
                        className={cn(
                          "flex flex-col items-center gap-0.5 rounded-xl border py-2 transition-colors",
                          selected
                            ? "border-orange-400/50 bg-orange-500/15 text-white"
                            : "border-white/10 bg-white/[0.03] text-white/55 hover:bg-white/[0.06]",
                        )}
                      >
                        <span className="text-[13px] leading-none">{SPICE_ICON[s]}</span>
                        <span className="text-[12px] font-medium">{s}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Live odds */}
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">
                  Live Odds
                  <Info className="h-3 w-3 text-white/25" aria-hidden />
                </p>
                <ul className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
                  {LIVE_ODDS[spice].map((o) => (
                    <li key={o.range} className="flex items-center justify-between border-b border-white/5 px-3.5 py-2.5 last:border-b-0">
                      <span className="text-[13px] tabular-nums text-white/75">{o.range}</span>
                      <span className="text-[13px] font-semibold tabular-nums text-white">{o.pct}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Demo spin */}
              <button
                type="button"
                onClick={spin}
                disabled={phase === "spinning"}
                className="flex h-11 items-center justify-between rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 text-sm font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-60"
              >
                <span className="flex items-center gap-2">
                  <Play className="h-4 w-4 fill-current" aria-hidden />
                  Try a free demo spin
                </span>
                <ArrowRight className="h-4 w-4" aria-hidden />
              </button>

              {/* Quantity */}
              <div className="flex items-center gap-2">
                <button type="button" aria-label="Decrease quantity" onClick={() => setQ(qty - 1)} disabled={qty <= 1} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">
                  <Minus className="h-4 w-4" aria-hidden />
                </button>
                <span className="flex h-10 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-sm font-medium tabular-nums text-white">
                  {qty} {qty === 1 ? "Pack" : "Packs"}
                </span>
                <button type="button" aria-label="Increase quantity" onClick={() => setQ(qty + 1)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white">
                  <Plus className="h-4 w-4" aria-hidden />
                </button>
                <button type="button" onClick={() => setQ(99)} className="flex h-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-3 text-[12px] font-bold uppercase tracking-wide text-white/60 transition-colors hover:bg-white/10 hover:text-white">
                  Max
                </button>
              </div>
            </div>

            {/* Open Pack — sticky footer of the panel */}
            <div className="border-t border-white/10 p-4">
              <button
                type="button"
                onClick={spin}
                disabled={phase === "spinning"}
                className="flex h-12 w-full items-center justify-between rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 px-5 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition-opacity hover:opacity-95 disabled:opacity-60"
              >
                <span className="flex items-center gap-2">
                  Open Pack
                  <span className="rounded-md bg-black/20 px-1.5 py-0.5 text-[11px] font-semibold">+{points.toLocaleString("en-US")} pts</span>
                </span>
                <span className="flex items-center gap-1.5">
                  ${(priceNum * qty).toLocaleString("en-US")}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </span>
              </button>
              <p className="mt-2 text-center text-[11px] text-white/35">
                Demo only — real opening, charging &amp; provably-fair pulls arrive with the backend.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {/* ===== Pull Odds + Recent Pulls (below the fold) ===== */}
      <div className="mb-10 mt-8 grid gap-6 lg:grid-cols-2">
        <Reveal as="section" className="h-full">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="font-heading text-lg font-bold tracking-tight text-white">Pull Odds (by rarity)</h2>
          </div>
          <ul className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
            {ODDS.map((o) => (
              <li key={o.rarity} className="flex items-center justify-between border-b border-white/5 px-4 py-3 last:border-b-0">
                <span className="flex items-center gap-2.5 text-[13px] font-medium text-white">
                  <span className={cn("h-2.5 w-2.5 rounded-full", o.dot)} />
                  {o.rarity}
                </span>
                <span className="text-[13px] tabular-nums text-white/55">{o.chance}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 px-1 text-[11px] text-white/35">Indicative odds — final rates are published by the backend.</p>
        </Reveal>

        <Reveal as="section" delay={90} className="h-full">
          <div className="mb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-white/50" aria-hidden />
            <h2 className="font-heading text-lg font-bold tracking-tight text-white">Recent Pulls</h2>
          </div>
          <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
            {CARD_POOL.slice(0, 5).map((c, i) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.image} alt="" className="h-10 w-8 shrink-0 rounded object-contain" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-white/80">{c.name}</span>
                <span className="shrink-0 text-[12px] tabular-nums text-white/45">{c.value}</span>
                <span className="hidden shrink-0 text-[11px] text-white/35 sm:inline">{(i + 1) * 2}m ago</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </div>
  );
}
