'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';
import {
  Filter,
  X,
  ChevronDown,
  ChevronsUpDown,
  Search,
  Heart,
  LayoutGrid,
  Store,
  Layers,
  Asterisk,
  Star,
  DollarSign,
  BarChart3,
  Flame,
  Diamond,
  BookMarked,
  Award,
  Medal,
  Calendar,
  Languages,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { MarketplaceCard, MarketplaceCategory } from '@/lib/data/products';
import { money } from '@/lib/format';

// Marketplace catalog data (cards + category tabs) now lives in the data seam,
// passed in as props from the server page. See @/lib/data/products.
type FilterGroup = { label: string; icon: LucideIcon; count?: number };
const FILTER_GROUPS: FilterGroup[] = [
  { label: 'Platform', icon: Layers, count: 1 },
  { label: 'Category', icon: Asterisk, count: 1 },
  { label: 'Grade Type', icon: Star, count: 1 },
  { label: 'Price Range', icon: DollarSign },
  { label: 'FMV Range', icon: BarChart3 },
  { label: 'Card Type', icon: Flame },
  { label: 'Rarity', icon: Diamond },
  { label: 'Set', icon: BookMarked },
  { label: 'Grader', icon: Award },
  { label: 'Grade', icon: Medal },
  { label: 'Year', icon: Calendar },
  { label: 'Language', icon: Languages },
];

function FilterSidebar({
  open,
  onClose,
  buyNow,
  onBuyNow,
}: {
  open: boolean;
  onClose: () => void;
  buyNow: boolean;
  onBuyNow: (v: boolean) => void;
}) {
  // Presentational collapse state — visual only, no real filtering.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const toggle = (label: string) =>
    setOpenGroups((s) => ({ ...s, [label]: !s[label] }));

  return (
    // Left drawer on ALL breakpoints (opened by the toolbar "Filters" button) — the
    // live marketplace has no persistent sidebar at desktop widths, just a Filters panel.
    <aside className={cn('fixed inset-0 z-40', open ? 'block' : 'hidden')}>
      <button
        type="button"
        aria-label="Close filters"
        onClick={onClose}
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />
      <div className="absolute left-0 top-0 flex h-full w-[min(20rem,90vw)] flex-col overflow-y-auto border-r border-white/10 bg-neutral-900 p-3">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-1 pb-3">
          <div className="flex items-center gap-2 text-white">
            <Filter className="h-4 w-4" aria-hidden />
            <span className="font-heading text-sm font-bold tracking-tight">
              Filters
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="rounded-lg p-1 text-white/50 transition-colors hover:bg-white/10 hover:text-white lg:hidden"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* Buy Now / All segmented control */}
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
          <button
            type="button"
            onClick={() => onBuyNow(true)}
            className={cn(
              'rounded-lg py-1.5 text-xs font-semibold transition-colors',
              buyNow
                ? 'bg-white/10 text-white'
                : 'text-white/45 hover:text-white/70',
            )}
          >
            Buy Now
          </button>
          <button
            type="button"
            onClick={() => onBuyNow(false)}
            className={cn(
              'rounded-lg py-1.5 text-xs font-semibold transition-colors',
              !buyNow
                ? 'bg-white/10 text-white'
                : 'text-white/45 hover:text-white/70',
            )}
          >
            All
          </button>
        </div>

        {/* Marketplace selector row (top of list, no count) */}
        <div className="mt-3 flex flex-col gap-1">
          <button
            type="button"
            className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.06]"
          >
            <span className="flex items-center gap-2.5">
              <Store className="h-4 w-4 text-white/55" aria-hidden />
              <span className="text-[13px] font-medium text-white">
                Marketplace
              </span>
            </span>
            <ChevronDown className="h-4 w-4 text-white/40" aria-hidden />
          </button>

          {/* Collapsible filter groups (presentational) */}
          {FILTER_GROUPS.map(({ label, icon: Icon, count }) => {
            const isOpen = openGroups[label] ?? false;
            return (
              <button
                key={label}
                type="button"
                onClick={() => toggle(label)}
                aria-expanded={isOpen}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.06]"
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 text-white/55" aria-hidden />
                  <span className="text-[13px] font-medium text-white">
                    {label}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {count !== undefined && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-white/15 bg-white/10 px-1.5 text-[10px] font-semibold text-white/80">
                      {count}
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 text-white/40 transition-transform duration-200',
                      isOpen && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </span>
              </button>
            );
          })}
        </div>

        {/* Clear all */}
        <button
          type="button"
          className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] py-2.5 text-[13px] font-semibold text-white/80 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          Clear All Filters
        </button>
      </div>
    </aside>
  );
}

function MarketCard({ card }: { card: MarketplaceCard }) {
  return (
    <article
      className={cn(
        'group/card h-full overflow-hidden rounded-2xl border border-white/10 bg-neutral-800',
        'transition-all duration-300 ease-out',
        'hover:-translate-y-1 hover:border-white/20 hover:shadow-xl hover:shadow-black/40',
      )}
    >
      {/* Image area on a dark radial pedestal */}
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-[radial-gradient(120%_80%_at_50%_15%,#2e2e2e_0%,#1c1c1c_55%,#141414_100%)]">
        {/* +pts badge, top-left */}
        <span className="absolute left-2 top-2 z-10 rounded-full bg-emerald-500/90 px-2 py-0.5 text-[11px] font-bold text-white shadow-sm">
          +{card.points}pts
        </span>
        {/* heart, top-right */}
        <button
          type="button"
          aria-label="Add to watchlist"
          className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white/55 backdrop-blur-sm transition-colors hover:text-white"
        >
          <Heart className="h-3.5 w-3.5" aria-hidden />
        </button>
        <Link
          href={`/card/${card.id}`}
          className="relative block h-full w-full"
          aria-label={card.title}
        >
          <Image
            src={card.image}
            alt={card.title}
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 16vw"
            className="object-contain p-3 transition-transform duration-300 ease-out group-hover/card:scale-[1.04]"
          />
        </Link>
      </div>

      {/* Footer */}
      <div className="flex flex-col gap-2 p-3">
        <Link
          href={`/card/${card.id}`}
          className="line-clamp-2 min-h-[32px] text-[12px] font-medium leading-4 text-white hover:text-white/80"
        >
          {card.title}
        </Link>
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-bold text-white">
            {money(card.price)}
          </span>
          <span className="text-[11px] font-medium text-white/45">
            FMV {money(card.fmv)}
          </span>
        </div>
      </div>
    </article>
  );
}

type MarketplaceClientProps = {
  cards: MarketplaceCard[];
  categories: MarketplaceCategory[];
};

export default function MarketplaceClient({
  cards,
  categories,
}: MarketplaceClientProps) {
  const [activeCategory, setActiveCategory] = useState<string>(
    categories[0]?.name ?? '',
  );
  const [buyNow, setBuyNow] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);

  return (
    <div className="mx-auto w-full px-fluid py-4">
      <div className="flex gap-6">
        {/* LEFT sidebar */}
        <FilterSidebar
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          buyNow={buyNow}
          onBuyNow={setBuyNow}
        />

        {/* RIGHT main content */}
        <div className="min-w-0 flex-1">
          {/* Category tab row — underline tabs (matches live: in the main column,
              grey inactive, white text + 2px white underline when active). */}
          <div className="mb-4 flex gap-0 overflow-x-auto border-b border-white/10 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {categories.map((cat) => {
              const active = cat.name === activeCategory;
              return (
                <button
                  key={cat.name}
                  type="button"
                  onClick={() => setActiveCategory(cat.name)}
                  className={cn(
                    '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors',
                    active
                      ? 'border-white text-white'
                      : 'border-transparent text-neutral-400 hover:text-white',
                  )}
                >
                  <Image
                    src={cat.icon}
                    alt=""
                    aria-hidden
                    width={20}
                    height={20}
                    className="h-5 w-5 shrink-0 rounded-full object-cover"
                  />
                  {cat.name}
                </button>
              );
            })}
          </div>

          {/* Toolbar — matches live: Filters button, search, view toggle + sort */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {/* Filters button (left) — opens the sidebar drawer on mobile */}
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className="flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-white/[0.08]"
            >
              <Filter className="h-4 w-4" aria-hidden />
              Filters
            </button>

            {/* Search (center) */}
            <div className="relative min-w-[200px] flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40"
                aria-hidden
              />
              <input
                type="search"
                placeholder="Search cards..."
                className="w-full rounded-xl border border-white/10 bg-white/[0.03] py-2 pl-9 pr-3 text-[13px] text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none"
              />
            </div>

            {/* View toggle (presentational) */}
            <button
              type="button"
              aria-label="Toggle view"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white"
            >
              <LayoutGrid className="h-4 w-4" aria-hidden />
            </button>

            {/* Sort (presentational) */}
            <button
              type="button"
              className="flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-white/[0.08]"
            >
              <ChevronsUpDown
                className="h-3.5 w-3.5 text-white/55"
                aria-hidden
              />
              <span className="text-white/55">Price:</span> Low to High
            </button>
          </div>

          {/* Card grid (or empty state when the catalog can't be loaded) */}
          {cards.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.02] py-20 text-center">
              <Store className="h-8 w-8 text-white/30" aria-hidden />
              <p className="text-sm font-medium text-white/70">
                No cards available right now
              </p>
              <p className="text-[13px] text-white/40">Check back shortly.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {cards.map((card, i) => (
                <Reveal
                  key={card.id}
                  delay={Math.min(i, 11) * 45}
                  className="h-full"
                >
                  <MarketCard card={card} />
                </Reveal>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
