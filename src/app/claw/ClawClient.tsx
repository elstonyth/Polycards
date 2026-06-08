"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import Reveal from "@/components/Reveal";
import type { Pack, PackCategory } from "./packs-data";

// Pack catalog comes from the backend via getPackCategories() (server page);
// types + presentational category meta still live in ./packs-data.

// ---------------------------------------------------------------------------
// Pack card (DESKTOP) — art, name, price, Open pill, buyback badge.
// No quantity stepper (live /claw has none — unlike /repacks).
// ---------------------------------------------------------------------------

function PackCard({ pack, icon }: { pack: Pack; icon: string }) {
  return (
    <div className="group relative flex h-full flex-col rounded-2xl border border-white/10 bg-white/5 p-3 shadow-[0_4px_20px_rgba(0,0,0,0.25)] transition-colors duration-300 hover:border-white/20">
      {/* Green buyback-boost badge — only on boosted tiers */}
      {pack.boost && (
        <span className="absolute left-3 top-3 z-[2] rounded-md bg-emerald-500/90 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-white shadow-sm sm:text-[10px]">
          +90% Buyback Boost
        </span>
      )}

      {/* Category badge (top-right) — real per-category icon from the live site */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={icon} alt="" aria-hidden="true" width={24} height={24} className="absolute right-3 top-3 z-[2] h-6 w-6 object-contain opacity-80" />

      {/* Pack image — the tall vertical pack art dominates the card, matching the
          live /claw's tall, narrow cards (art is natively ~0.57 aspect). */}
      <div className="flex items-center justify-center pb-2 pt-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={pack.image}
          alt={pack.name}
          width={205}
          height={360}
          loading="lazy"
          className="h-52 w-auto object-contain drop-shadow-[0_12px_28px_rgba(0,0,0,0.5)] transition-transform duration-300 ease-out group-hover:-translate-y-1 sm:h-60"
        />
      </div>

      {/* Name + price */}
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] font-semibold text-white sm:text-sm">{pack.name}</span>
        <span className="shrink-0 text-[13px] font-semibold text-white/90 sm:text-sm">{pack.price}</span>
      </div>

      {/* Open button → pack detail / opening template */}
      <Link
        href={`/claw/${pack.id}`}
        className="mt-auto flex h-9 w-full items-center justify-center rounded-xl bg-neutral-200 text-[13px] font-semibold text-neutral-950 transition-colors duration-200 hover:bg-white"
      >
        Open
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pack row (MOBILE) — horizontal list row matching live /claw mobile:
// thumb | name + buyback badge | price pill (the whole row is the tap target).
// ---------------------------------------------------------------------------

function PackRow({ pack, icon, categoryName }: { pack: Pack; icon: string; categoryName: string }) {
  return (
    <Link
      href={`/claw/${pack.id}`}
      className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-2.5 transition-colors hover:border-white/20 hover:bg-white/[0.07]"
    >
      {/* Thumbnail + category chip */}
      <div className="relative flex h-16 w-14 shrink-0 items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={pack.image} alt={pack.name} className="h-16 w-auto object-contain drop-shadow-[0_6px_14px_rgba(0,0,0,0.5)]" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={icon} alt="" aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full object-contain" />
      </div>

      {/* Name + buyback line */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-0.5 text-sm font-semibold text-white">
          <span className="truncate">{pack.name}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden />
        </div>
        {pack.boost ? (
          <span className="mt-1 inline-block rounded bg-emerald-500/90 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-white">
            +90% Buyback Boost
          </span>
        ) : (
          <span className="mt-1 block text-[11px] text-white/45">{categoryName} · 85% buyback</span>
        )}
      </div>

      {/* Price pill (tap target) */}
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-neutral-950">
        {pack.price}
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Client — per-category sections (matches live /claw: "Pokémon Packs / 5 packs"
// headings). Desktop renders a card grid per section; mobile renders list rows.
// The chip rail scopes to a single category (or "All Packs"); `initialCategory`
// lets a deep link (/claw?category=<key>) preselect a tab.
// ---------------------------------------------------------------------------

export default function ClawClient({
  categories,
  initialCategory,
}: {
  categories: PackCategory[];
  initialCategory: string;
}) {
  const [active, setActive] = useState<string>(initialCategory);
  const [creatorPacks, setCreatorPacks] = useState(false);

  const tabs = [{ id: "all", tab: "All Packs", icon: "" }, ...categories.map((c) => ({ id: c.id, tab: c.tab, icon: c.icon }))];
  const visible = active === "all" ? categories : categories.filter((c) => c.id === active);

  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* Sticky filter bar — chip rail + sort + Creator Packs toggle */}
      <div className="sticky top-2 z-20 mb-6 flex flex-col gap-3 rounded-2xl border border-white/10 bg-neutral-950/80 p-2 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/60 lg:flex-row lg:items-center lg:justify-between">
        {/* Category chip rail (icons + label) */}
        <div className="flex items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              aria-pressed={active === t.id}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors sm:text-[13px]",
                active === t.id ? "bg-white text-neutral-950" : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white",
              )}
            >
              {t.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={t.icon} alt="" aria-hidden="true" className="h-4 w-4 shrink-0 rounded-full object-cover" />
              ) : (
                <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              {t.tab}
            </button>
          ))}
        </div>

        {/* Sort + Creator Packs toggle (presentational) */}
        <div className="flex shrink-0 items-center gap-3 px-1">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white sm:text-[13px]"
          >
            Most Popular
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setCreatorPacks((v) => !v)}
            aria-pressed={creatorPacks}
            className="inline-flex items-center gap-2 text-[12px] font-medium text-white/70 transition-colors hover:text-white sm:text-[13px]"
          >
            <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", creatorPacks ? "bg-emerald-500" : "bg-white/15")}>
              <span className={cn("absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform", creatorPacks && "translate-x-4")} />
            </span>
            Creator Packs
          </button>
        </div>
      </div>

      {/* Per-category sections */}
      {visible.map((cat) => (
        <section key={cat.id} className="mb-8">
          {/* Section header */}
          <div className="mb-4 flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={cat.icon} alt="" aria-hidden="true" className="h-6 w-6 shrink-0 rounded-full object-cover" />
            <h2 className="font-heading text-lg font-bold tracking-tight text-white sm:text-xl">{cat.heading}</h2>
            <span className="ml-auto text-[13px] text-white/45">{cat.packs.length} packs</span>
          </div>

          {/* Desktop: card grid */}
          <div className="hidden grid-cols-3 gap-4 sm:grid md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
            {cat.packs.map((p, i) => (
              <Reveal key={p.id} delay={Math.min(i, 6) * 50} className="h-full">
                <PackCard pack={p} icon={cat.icon} />
              </Reveal>
            ))}
          </div>

          {/* Mobile: list rows */}
          <div className="flex flex-col gap-2 sm:hidden">
            {cat.packs.map((p) => (
              <PackRow key={p.id} pack={p} icon={cat.icon} categoryName={cat.tab} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
