'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Eye, Search, Star } from 'lucide-react';
import { SlabImage } from '@/components/SlabImage';
import { rm, rm0 } from '@/lib/format';
import {
  getVault,
  sellBackPullsBatch,
  toggleShowcase,
  type VaultItem,
  type VaultResult,
} from '@/lib/actions/vault';
import { type AddressView } from '@/lib/actions/delivery';
import RequestDeliveryModal from '@/components/account/RequestDeliveryModal';
import { SuccessToast } from '@/components/ui/SuccessToast';
import { FLAT_BUYBACK_PERCENT } from '@/lib/packs-data';
import SellConfirmModal from '@/components/SellConfirmModal';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { RARITY_ORDER, rarityRgb } from '@/lib/rarity';
import { cn } from '@/lib/utils';
import { Pill, pillVariants } from '@/components/ui/pill';
import {
  CardDetailOverlay,
  type CardSeed,
} from '@/components/cards/CardDetailOverlay';
import { formatValue, isRarity } from '@/lib/packs-format';
import { toggleSelectAll } from '@/lib/vault-selection';
import { VaultActionBar } from '@/components/account/VaultActionBar';
import { useConsent } from '@/lib/use-consent';

// The customer's vault: every pulled card still held, each with a sell-back
// offer (current FMV × the flat buyback rate — the server quotes the percent).
// Selling removes the card here and credits the site balance shown at the top.
export default function VaultClient({
  initial,
  addresses,
}: {
  initial: VaultResult;
  addresses: AddressView[];
}) {
  const [items, setItems] = useState<VaultItem[]>(
    initial.ok ? initial.items : [],
  );
  const [balance, setBalance] = useState<number>(
    initial.ok ? initial.balance : 0,
  );
  const [error, setError] = useState<string | null>(
    initial.ok ? null : initial.error,
  );
  // Success confirmation (e.g. "Sold N cards for RM X — added to your balance").
  // Distinct from `error` so a sale reads as a positive result, not a warning.
  const [notice, setNotice] = useState<string | null>(null);
  // Transient top-of-screen confirmation for shipping orders (auto-dismisses).
  const [toast, setToast] = useState<string | null>(null);
  const [showcasingId, setShowcasingId] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<CardSeed | null>(null);

  // Two-way sync with the header chip: sells push fresh balances up via
  // applyBalance; top-ups made in the global sheet flow back down through
  // providerBalance (review finding — the stat went stale one-way).
  const { balance: providerBalance, applyBalance } = useTopUp();
  // While cookie consent is undecided, the banner (z-50) docks exactly where
  // the action bar (z-40) lives and would cover its pills — hide the bar (and
  // its scroll spacer) until the visitor answers; CONSENT_EVENT re-shows it
  // the moment they do.
  const consent = useConsent();
  const syncBalance = (next: number) => {
    setBalance(next);
    applyBalance(next);
  };

  // Client-side search + rarity filter (the backend returns the full vault).
  const [query, setQuery] = useState('');
  const [rarityFilter, setRarityFilter] = useState<string | null>(null);

  // Multi-select → bulk ship or bulk sell-back.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [confirmBulkSell, setConfirmBulkSell] = useState(false);
  const [bulkSelling, setBulkSelling] = useState(false);

  const toggleSelect = (pullId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pullId)) next.delete(pullId);
      else next.add(pullId);
      return next;
    });
  const selectedItems = items.filter((i) => selected.has(i.pullId));
  // Money display must use the MYR price (marketPriceMyr) — card.marketValue
  // is the raw USD FMV from PriceCharting and must never render behind "RM".
  const selectedFmv = selectedItems.reduce(
    (s, i) => s + (i.card.marketPriceMyr ?? 0),
    0,
  );
  const selectedBuyback = selectedItems.reduce(
    (s, i) => s + i.buyback.amount,
    0,
  );
  // The vault buyback is a flat rate, uniform across all vaulted items (see the
  // footer copy + actions/vault.ts), so the first item's percent represents the
  // whole batch. The confirm's "You receive" total is the exact sum of per-item
  // amounts (selectedBuyback) — independent of this — so only the displayed rate
  // label leans on the invariant, and the credited total stays correct anyway.
  const selectedPercent =
    selectedItems[0]?.buyback.percent ?? FLAT_BUYBACK_PERCENT;

  // FX firmness is global (one rate), so any non-firm quote means all quotes
  // are on the display fallback and the backend would refuse every sell —
  // gate the sell CTAs and say why instead of letting the 400 explain it.
  const quotesFirm = items.every((i) => i.buyback.firm);

  const vaultValue = items.reduce(
    (sum, i) => sum + (i.card.marketPriceMyr ?? 0),
    0,
  );

  const raritiesPresent = useMemo(() => {
    const present = new Set(items.map((i) => i.card.rarity));
    return RARITY_ORDER.filter((r) => present.has(r));
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        (!q || i.card.name.toLowerCase().includes(q)) &&
        (!rarityFilter || i.card.rarity === rarityFilter),
    );
  }, [items, query, rarityFilter]);

  // Progressive paging: render the grid in steps so a 500-card vault doesn't
  // mount hundreds of slab images at once. Selection/select-all still operate
  // on the FULL filtered set (`visible`), only rendering is windowed.
  const PAGE_STEP = 30;
  const [shownCount, setShownCount] = useState(PAGE_STEP);
  useEffect(() => {
    // New search/filter → back to the first window.
    setShownCount(PAGE_STEP);
  }, [query, rarityFilter]);
  const shown = visible.slice(0, shownCount);

  const visibleIds = visible.map((i) => i.pullId);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  async function handleToggleShowcase(item: VaultItem) {
    if (showcasingId) return;
    setShowcasingId(item.pullId);
    // Optimistic update
    setItems((prev) =>
      prev.map((i) =>
        i.pullId === item.pullId ? { ...i, showcased: !item.showcased } : i,
      ),
    );
    try {
      const res = await toggleShowcase(item.pullId, !item.showcased);
      if (!res.ok) {
        // Revert on failure
        setItems((prev) =>
          prev.map((i) =>
            i.pullId === item.pullId ? { ...i, showcased: item.showcased } : i,
          ),
        );
        setError(res.error);
      } else {
        // Align to the server-confirmed state and clear any stale error.
        setItems((prev) =>
          prev.map((i) =>
            i.pullId === item.pullId ? { ...i, showcased: res.showcased } : i,
          ),
        );
        setError(null);
      }
    } catch {
      setItems((prev) =>
        prev.map((i) =>
          i.pullId === item.pullId ? { ...i, showcased: item.showcased } : i,
        ),
      );
      setError('Something went wrong. Please try again.');
    } finally {
      setShowcasingId(null);
    }
  }

  // Bulk sell-back in ONE request. The previous version looped the single-pull
  // buyback client-side, which under the per-pull rate limiter (10/10s burst)
  // capped a bulk sell at ~10 cards and forced the user to press repeatedly for
  // a large vault — cards appearing to "vanish" as the rest silently rate-
  // limited. The batch endpoint sells every selected pull server-side with the
  // same atomic per-pull logic, so the whole selection clears at once and the
  // balance jumps by the full credited amount (no pull leaves the vault
  // without payment; un-sellable ones are reported, not lost).
  // Re-read the vault from the server as the source of truth. Used to self-heal
  // after a batch failure: a batch can partial-commit and then error/time out,
  // and the client can't know which pulls sold — so it re-reads rather than
  // guess (a sold pull would otherwise linger in the list, credited but shown).
  async function refreshVault() {
    const fresh = await getVault();
    if (fresh.ok) {
      setItems(fresh.items);
      setSelected(new Set());
      syncBalance(fresh.balance);
    }
  }

  async function bulkSell() {
    if (bulkSelling) return;
    setError(null);
    setNotice(null);
    setBulkSelling(true);
    const ids = selectedItems.map((i) => i.pullId);
    try {
      const res = await sellBackPullsBatch(ids);
      setConfirmBulkSell(false);

      if (!res.ok) {
        setError(res.error);
        // The batch may have committed some sales before failing — re-read the
        // server so sold cards leave the list and the balance reflects them.
        await refreshVault();
        return;
      }

      // Remove exactly the pulls that sold (never the whole selection) and
      // credit the balance by the real total — so what leaves the vault always
      // matches what was paid for.
      if (res.soldIds.length > 0) {
        const soldSet = new Set(res.soldIds);
        setItems((prev) => prev.filter((i) => !soldSet.has(i.pullId)));
        setSelected((prev) => {
          const next = new Set(prev);
          res.soldIds.forEach((id) => next.delete(id));
          return next;
        });
        syncBalance(res.balance);
      }

      if (res.failed > 0) {
        setError(
          `Sold ${res.sold} card${res.sold === 1 ? '' : 's'} for ${rm(
            res.credited,
          )}. ${res.failed} couldn't be sold${
            res.firstError ? ` — ${res.firstError}` : ''
          }.`,
        );
      } else {
        // Explicit money confirmation — the whole complaint was "sold, no money."
        setNotice(
          `Sold ${res.sold} card${res.sold === 1 ? '' : 's'} for ${rm(
            res.credited,
          )} — added to your balance.`,
        );
      }
    } finally {
      // Always re-enable the button — never strand it disabled if the action
      // ever throws (today it returns a result, but this removes the footgun).
      setBulkSelling(false);
    }
  }

  return (
    <>
      {/* Title + subtitle live in the server page (shared AccountHeader). */}
      {/* Stat strip */}
      <div className="grid grid-cols-3 divide-x divide-white/10 rounded-2xl border border-white/10 bg-neutral-900 py-4">
        {[
          // rm0 (whole ringgit) keeps both money stats from clipping in the
          // 3-col strip on narrow phones; exact figures live per-card and in
          // the header chip.
          { label: 'Vault value', value: rm0(vaultValue) },
          { label: 'Cards', value: String(items.length) },
          { label: 'Balance', value: rm0(providerBalance ?? balance) },
        ].map((stat) => (
          <div key={stat.label} className="px-4 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              {stat.label}
            </p>
            <p className="font-heading mt-0.5 truncate text-base tabular-nums text-white lg:text-lg">
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Search + rarity filter */}
      {items.length > 0 && (
        <div className="mt-4 flex flex-col gap-2.5">
          <label className="flex h-11 items-center gap-2 rounded-xl bg-neutral-800 px-3.5">
            <Search className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your cards"
              aria-label="Search your cards"
              className="w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-400"
            />
          </label>
          {raritiesPresent.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-0.5">
              <button
                type="button"
                onClick={() => setRarityFilter(null)}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center rounded-full px-3.5 text-[12px] font-semibold transition-colors',
                  rarityFilter === null
                    ? 'bg-neutral-50 text-neutral-950'
                    : 'bg-neutral-800 text-neutral-400 hover:text-white',
                )}
              >
                All
              </button>
              {raritiesPresent.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() =>
                    setRarityFilter((cur) => (cur === r ? null : r))
                  }
                  className={cn(
                    'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold transition-colors',
                    rarityFilter === r
                      ? 'bg-neutral-50 text-neutral-950'
                      : 'bg-neutral-800 text-neutral-400 hover:text-white',
                  )}
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: `rgb(${rarityRgb(r)})` }}
                  />
                  {r}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300"
        >
          {error}
        </p>
      )}

      {notice && (
        <p
          role="status"
          className="mt-4 rounded-xl border border-buyback-fg/30 bg-buyback-fg/10 px-4 py-3 text-[13px] font-medium text-buyback-fg"
        >
          {notice}
        </p>
      )}

      {!quotesFirm && (
        <p
          role="status"
          className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-[13px] font-medium text-amber-300"
        >
          Sell-back is temporarily unavailable while pricing is refreshed — your
          cards are safe here and can be sold once rates are back.
        </p>
      )}

      {items.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-white/10 bg-neutral-900 px-6 py-12 text-center">
          <p className="text-sm font-semibold text-white">
            Your vault is empty.
          </p>
          <p className="mt-1 text-[13px] text-neutral-400">
            Rip a pack and the card you pull lands here.
          </p>
          <Link
            href="/"
            className={cn(pillVariants({ size: 'md' }), 'mt-5 px-6')}
          >
            Open packs
          </Link>
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-white/10 bg-neutral-900 px-6 py-10 text-center">
          <p className="text-sm text-neutral-400">
            Nothing matches
            {query ? ` “${query.trim()}”` : ''}
            {rarityFilter ? ` in ${rarityFilter}` : ''}.
          </p>
          <Pill
            variant="secondary"
            size="sm"
            onClick={() => {
              setQuery('');
              setRarityFilter(null);
            }}
            className="mt-3 h-9 text-[13px]"
          >
            Clear filters
          </Pill>
        </div>
      ) : (
        // Mobile-first: 3-up keeps a scroll rhythm of ~2 rows per screen —
        // 2-up slabs dominated the viewport and made browsing feel stuck.
        <div className="mt-5 grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-4">
          {shown.map((item) => {
            const isSelected = selected.has(item.pullId);
            const glow = rarityRgb(item.card.rarity);
            const art = (
              // Pass `rarity` so the slab renders its tier frame + halo, matching
              // the pool and card-detail (operator 2026-07-18 — the vault was
              // showing the bare baked slab with only a faint drop-shadow, so the
              // tier frame never appeared here).
              <SlabImage
                src={item.card.image}
                slabSrc={item.card.slabImage}
                rarity={item.card.rarity}
                alt={item.card.name}
                sizes="(max-width: 1024px) 33vw, 25vw"
                className="w-full"
              />
            );
            return (
              <div
                key={item.pullId}
                className={cn(
                  'relative flex flex-col rounded-2xl border bg-neutral-900 p-2 transition-colors sm:p-3',
                  isSelected
                    ? 'border-white ring-2 ring-white/50'
                    : 'border-white/10',
                )}
              >
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => toggleSelect(item.pullId)}
                    aria-pressed={isSelected}
                    aria-label={
                      isSelected
                        ? `Deselect ${item.card.name}`
                        : `Select ${item.card.name}`
                    }
                    className="relative block w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  >
                    {art}
                    <span
                      className={cn(
                        'absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border text-[13px] font-bold',
                        isSelected
                          ? 'border-white bg-neutral-50 text-neutral-950'
                          : 'border-white/40 bg-black/50 text-transparent',
                      )}
                      aria-hidden
                    >
                      ✓
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleShowcase(item)}
                    disabled={showcasingId !== null}
                    aria-pressed={item.showcased}
                    title={
                      item.showcased
                        ? 'Remove from profile showcase'
                        : 'Feature on profile'
                    }
                    className={cn(
                      'absolute left-1 top-1 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 transition-colors disabled:opacity-50 sm:h-9 sm:w-9',
                      item.showcased
                        ? 'text-chase'
                        : 'text-neutral-400 hover:text-white',
                    )}
                  >
                    <Star
                      className={cn(
                        'h-3.5 w-3.5',
                        item.showcased && 'fill-current',
                      )}
                      aria-hidden
                    />
                    <span className="sr-only">
                      {item.showcased ? 'On profile' : 'Feature on profile'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setOpenCard({
                        handle: item.card.handle,
                        name: item.card.name,
                        image: item.card.image,
                        slabImage: item.card.slabImage,
                        value: formatValue(item.card.marketPriceMyr),
                        rarity: isRarity(item.card.rarity)
                          ? item.card.rarity
                          : null,
                      })
                    }
                    aria-label={`View details for ${item.card.name}`}
                    className="absolute bottom-1 left-1 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-neutral-950/70 text-white/80 backdrop-blur transition-colors hover:bg-neutral-950/90 hover:text-white sm:bottom-2 sm:left-2 sm:h-8 sm:w-8"
                  >
                    <Eye className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                <p
                  className="mt-1.5 line-clamp-2 min-h-[1.9rem] text-[11px] font-semibold leading-snug text-white sm:mt-2 sm:min-h-[2.1rem] sm:text-[12px]"
                  title={item.card.name}
                >
                  {item.card.name}
                </p>
                <div className="mt-1 flex items-center justify-between gap-1 text-[10px] sm:text-[11px]">
                  <span
                    className="truncate font-bold uppercase tracking-wider"
                    style={{ color: `rgb(${glow})` }}
                  >
                    {item.card.rarity}
                  </span>
                  <span className="font-heading shrink-0 text-[12px] text-white sm:text-[13px]">
                    {rm(item.card.marketPriceMyr ?? 0)}
                  </span>
                </div>
                {/* pack origin is secondary meta — desktop-only so 3-up phone
                    tiles stay two text rows tall */}
                <p
                  className="mt-0.5 hidden truncate text-[11px] text-neutral-400 sm:block"
                  title={item.packTitle}
                >
                  from {item.packTitle}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {visible.length > 0 && (
        <div className="mt-4 flex flex-col items-center gap-2.5">
          <p className="text-[12px] text-neutral-400">
            Showing {Math.min(shownCount, visible.length)} of {visible.length}{' '}
            card{visible.length === 1 ? '' : 's'}
          </p>
          {visible.length > shownCount && (
            <Pill
              variant="secondary"
              size="sm"
              onClick={() => setShownCount((n) => n + PAGE_STEP)}
              className="px-6"
            >
              Show more
            </Pill>
          )}
        </div>
      )}

      <p className="mt-5 text-[12px] text-neutral-400">
        Sell-back credits your site balance instantly at the flat{' '}
        {FLAT_BUYBACK_PERCENT}% buyback rate. Physical shipping of vaulted cards
        arrives with checkout.
      </p>

      {items.length > 0 && consent !== null && (
        <div aria-hidden className="h-36" />
      )}

      {items.length > 0 && consent !== null && (
        <VaultActionBar
          selectedCount={selected.size}
          allVisibleSelected={allVisibleSelected}
          visibleCount={visibleIds.length}
          fmv={selectedFmv}
          sellTotal={selectedBuyback}
          quotesFirm={quotesFirm}
          busy={bulkSelling}
          onToggleSelectAll={() =>
            setSelected((prev) => toggleSelectAll(prev, visibleIds))
          }
          onSell={() => setConfirmBulkSell(true)}
          onDeliver={() => setDeliverOpen(true)}
        />
      )}

      {confirmBulkSell && (
        <SellConfirmModal
          open
          count={selectedItems.length === 1 ? undefined : selectedItems.length}
          cardName={
            selectedItems.length === 1
              ? (selectedItems[0]?.card.name ?? '')
              : `${selectedItems.length} cards from your vault`
          }
          image={
            selectedItems.length === 1
              ? (selectedItems[0]?.card.image ?? '')
              : ''
          }
          slabImage={
            selectedItems.length === 1
              ? selectedItems[0]?.card.slabImage
              : undefined
          }
          fmv={selectedFmv}
          rateType="flat"
          percent={selectedPercent}
          netCredit={selectedBuyback}
          busy={bulkSelling}
          onConfirm={bulkSell}
          onCancel={() => !bulkSelling && setConfirmBulkSell(false)}
        />
      )}

      <RequestDeliveryModal
        open={deliverOpen}
        items={selectedItems}
        addresses={addresses}
        onClose={() => setDeliverOpen(false)}
        onSubmitted={(pullIds) => {
          setItems((prev) => prev.filter((i) => !pullIds.includes(i.pullId)));
          setSelected(new Set());
          setDeliverOpen(false);
          setError(null);
          setToast('Shipping order created successfully!');
        }}
      />

      {/* Always mounted: the live region must pre-exist its message so screen
          readers announce it (see SuccessToast). */}
      <SuccessToast message={toast} onClose={() => setToast(null)} />

      <CardDetailOverlay seed={openCard} onClose={() => setOpenCard(null)} />
    </>
  );
}
