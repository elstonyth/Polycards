'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Search, Star } from 'lucide-react';
import { rm, rm0 } from '@/lib/format';
import {
  sellBackPull,
  toggleShowcase,
  type VaultItem,
  type VaultResult,
} from '@/lib/actions/vault';
import { type AddressView } from '@/lib/actions/delivery';
import RequestDeliveryModal from '@/components/account/RequestDeliveryModal';
import { FLAT_BUYBACK_PERCENT } from '@/lib/packs-data';
import SellConfirmModal from '@/components/SellConfirmModal';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { RARITY_ORDER, rarityRgb } from '@/lib/rarity';
import { cn } from '@/lib/utils';
import { Pill, pillVariants } from '@/components/ui/pill';

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
  const [sellingId, setSellingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    initial.ok ? null : initial.error,
  );
  const [confirmItem, setConfirmItem] = useState<VaultItem | null>(null);
  const [showcasingId, setShowcasingId] = useState<string | null>(null);

  // Two-way sync with the header chip: sells push fresh balances up via
  // applyBalance; top-ups made in the global sheet flow back down through
  // providerBalance (review finding — the stat went stale one-way).
  const { balance: providerBalance, applyBalance } = useTopUp();
  const syncBalance = (next: number) => {
    setBalance(next);
    applyBalance(next);
  };

  // Client-side search + rarity filter (the backend returns the full vault).
  const [query, setQuery] = useState('');
  const [rarityFilter, setRarityFilter] = useState<string | null>(null);

  // Multi-select → bulk ship or bulk sell-back.
  const [selectMode, setSelectMode] = useState(false);
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
  const selectedFmv = selectedItems.reduce((s, i) => s + i.card.marketValue, 0);
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

  const vaultValue = items.reduce((sum, i) => sum + i.card.marketValue, 0);

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

  async function sell(item: VaultItem) {
    if (sellingId) return;
    setError(null);
    setSellingId(item.pullId);
    try {
      const res = await sellBackPull(item.pullId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setItems((prev) => prev.filter((i) => i.pullId !== item.pullId));
      syncBalance(res.balance);
    } catch {
      // A transport-level throw must still surface feedback, not fail silently.
      setError('Something went wrong. Please try again.');
    } finally {
      setSellingId(null);
    }
  }

  // ponytail: bulk sell-back loops the single-pull buyback. The backend has no
  // batch route and serializes credit writes per-customer (advisory lock), so a
  // sequential loop is correct; add a server-side batch action if a vault ever
  // holds enough cards that the round-trips matter.
  async function bulkSell() {
    if (bulkSelling) return;
    setError(null);
    setBulkSelling(true);
    const ids = selectedItems.map((i) => i.pullId);
    const sold: string[] = [];
    let lastBalance: number | null = null;
    // Remember the first failure's reason so the summary can say WHY (e.g. rate
    // limited vs already sold), not just how many — keeps going either way so
    // one failure doesn't strand the rest of the batch.
    let firstError: string | null = null;
    for (const id of ids) {
      try {
        const res = await sellBackPull(id);
        if (res.ok) {
          sold.push(id);
          lastBalance = res.balance;
        } else if (!firstError) {
          firstError = res.error;
        }
      } catch {
        if (!firstError) firstError = 'Something went wrong. Please try again.';
      }
    }
    if (sold.length > 0) {
      const soldSet = new Set(sold);
      setItems((prev) => prev.filter((i) => !soldSet.has(i.pullId)));
      setSelected((prev) => {
        const next = new Set(prev);
        sold.forEach((id) => next.delete(id));
        return next;
      });
    }
    if (lastBalance !== null) syncBalance(lastBalance);
    const failed = ids.length - sold.length;
    setBulkSelling(false);
    setConfirmBulkSell(false);
    if (failed > 0) {
      setError(
        `${failed} card${failed === 1 ? '' : 's'} couldn't be sold back${
          sold.length > 0 ? ` — the other ${sold.length} sold` : ''
        }.${firstError ? ` ${firstError}` : ''}`,
      );
    } else {
      setSelectMode(false);
    }
  }

  return (
    <>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-heading text-3xl text-white">VAULT</h1>
          <p className="mt-1 text-[13px] text-neutral-400">
            Every card you&rsquo;ve pulled — hold, ship, or sell back instantly.
          </p>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setSelectMode((s) => !s);
              setSelected(new Set());
            }}
            className={cn(
              'inline-flex h-9 items-center rounded-full px-4 text-[13px] font-semibold transition-colors',
              selectMode
                ? 'bg-neutral-50 text-neutral-950'
                : 'bg-neutral-800 text-neutral-300 hover:text-white',
            )}
          >
            {selectMode ? 'Done' : 'Select'}
          </button>
        )}
      </div>

      {/* Stat strip */}
      <div className="mt-4 grid grid-cols-3 divide-x divide-white/10 rounded-2xl border border-white/10 bg-neutral-900 py-4">
        {[
          // rm0 (whole ringgit) keeps both money stats from clipping in the
          // 3-col strip on narrow phones; exact figures live per-card and in
          // the header chip.
          { label: 'Vault value', value: rm0(vaultValue) },
          { label: 'Cards', value: String(items.length) },
          { label: 'Balance', value: rm0(providerBalance ?? balance) },
        ].map((stat) => (
          <div key={stat.label} className="px-4 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
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
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300">
          {error}
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
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((item) => {
            const isSelected = selected.has(item.pullId);
            const glow = rarityRgb(item.card.rarity);
            const art = (
              <div
                className="relative aspect-[3/4] w-full overflow-hidden rounded-lg border"
                style={{
                  borderColor: `rgba(${glow}, 0.55)`,
                  boxShadow: `0 0 16px -8px rgba(${glow}, 0.6)`,
                }}
              >
                <Image
                  src={item.card.image}
                  alt={item.card.name}
                  fill
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                  className="object-contain"
                />
              </div>
            );
            return (
              <div
                key={item.pullId}
                className={cn(
                  'relative flex flex-col rounded-2xl border bg-neutral-900 p-3 transition-colors',
                  selectMode && isSelected
                    ? 'border-white ring-2 ring-white/50'
                    : 'border-white/10',
                )}
              >
                {selectMode ? (
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
                ) : (
                  <div className="relative">
                    {art}
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
                        'absolute left-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 transition-colors disabled:opacity-50',
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
                  </div>
                )}
                <p
                  className="mt-2 line-clamp-2 min-h-[2.1rem] text-[12px] font-semibold leading-snug text-white"
                  title={item.card.name}
                >
                  {item.card.name}
                </p>
                <div className="mt-1 flex items-center justify-between text-[11px]">
                  <span
                    className="font-bold uppercase tracking-wider"
                    style={{ color: `rgb(${glow})` }}
                  >
                    {item.card.rarity}
                  </span>
                  <span className="font-heading text-[13px] text-white">
                    {rm(item.card.marketPriceMyr ?? 0)}
                  </span>
                </div>
                <p
                  className="mt-0.5 truncate text-[11px] text-neutral-500"
                  title={item.packTitle}
                >
                  from {item.packTitle}
                </p>
                {!selectMode && (
                  <Pill
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirmItem(item)}
                    disabled={sellingId !== null}
                    className="mt-2.5 h-9 text-[12px] text-buyback-fg"
                  >
                    {sellingId === item.pullId
                      ? 'Selling…'
                      : `Sell · ${rm(item.buyback.amount)} (${item.buyback.percent}%)`}
                  </Pill>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-5 text-[12px] text-neutral-500">
        Sell-back credits your site balance instantly at the flat{' '}
        {FLAT_BUYBACK_PERCENT}% buyback rate. Physical shipping of vaulted cards
        arrives with checkout.
      </p>

      {/* Bulk action bar — floats above the tab bar while selecting. */}
      {selectMode && selected.size > 0 && (
        <div className="fixed inset-x-4 bottom-24 z-40 mx-auto max-w-md rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow-[0_8px_32px_rgba(0,0,0,0.6)] lg:bottom-8">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              {selected.size} selected · FMV {rm(selectedFmv)}
            </span>
            <span className="text-[13px] font-semibold text-buyback-fg">
              Sell for {rm(selectedBuyback)}
            </span>
          </div>
          <div className="mt-3 flex gap-2">
            <Pill onClick={() => setConfirmBulkSell(true)} className="flex-1">
              Sell {selected.size}
            </Pill>
            <Pill
              variant="secondary"
              onClick={() => setDeliverOpen(true)}
              className="flex-1"
            >
              Deliver {selected.size}
            </Pill>
          </div>
        </div>
      )}

      {confirmItem && (
        <SellConfirmModal
          open
          cardName={confirmItem.card.name}
          image={confirmItem.card.image}
          fmv={confirmItem.card.marketValue}
          rateType="flat"
          percent={confirmItem.buyback.percent}
          netCredit={confirmItem.buyback.amount}
          busy={sellingId === confirmItem.pullId}
          onConfirm={async () => {
            const item = confirmItem;
            await sell(item);
            setConfirmItem(null);
          }}
          onCancel={() => setConfirmItem(null)}
        />
      )}

      {confirmBulkSell && (
        <SellConfirmModal
          open
          count={selectedItems.length}
          cardName={`${selectedItems.length} card${
            selectedItems.length === 1 ? '' : 's'
          } from your vault`}
          image=""
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
          setSelectMode(false);
          setDeliverOpen(false);
        }}
      />
    </>
  );
}
