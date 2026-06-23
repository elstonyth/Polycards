'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Star } from 'lucide-react';
import { AccountHeader, StatCards } from '@/components/account/ui';
import { AddCreditsPanel } from '@/components/account/AddCreditsPanel';
import { usd } from '@/lib/format';
import {
  sellBackPull,
  toggleShowcase,
  type VaultItem,
  type VaultResult,
} from '@/lib/actions/vault';
import { type AddressView } from '@/lib/actions/delivery';
import RequestDeliveryModal from '@/components/account/RequestDeliveryModal';
import { FLAT_BUYBACK_PERCENT } from '@/app/claw/packs-data';
import SellConfirmModal from '@/components/SellConfirmModal';
import { cn } from '@/lib/utils';

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

  // Multi-select → request-delivery flow.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deliverOpen, setDeliverOpen] = useState(false);

  const toggleSelect = (pullId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pullId)) next.delete(pullId);
      else next.add(pullId);
      return next;
    });
  const selectedItems = items.filter((i) => selected.has(i.pullId));

  const vaultValue = items.reduce((sum, i) => sum + i.card.marketValue, 0);

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
      setBalance(res.balance);
    } catch {
      // A transport-level throw must still surface feedback, not fail silently.
      setError('Something went wrong. Please try again.');
    } finally {
      setSellingId(null);
    }
  }

  return (
    <>
      <AccountHeader
        title="Vault"
        sub="Cards you've pulled — keep them safe here, or sell back instantly for site credit."
      />
      <StatCards
        items={[
          { label: 'Credit balance', value: usd(balance) },
          { label: 'Cards in vault', value: String(items.length) },
          { label: 'Vault value (FMV)', value: usd(vaultValue) },
        ]}
      />

      <AddCreditsPanel onToppedUp={(newBalance) => setBalance(newBalance)} />

      {items.length > 0 && (
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              setSelectMode((s) => !s);
              setSelected(new Set());
            }}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] font-semibold text-white/70 hover:text-white"
          >
            {selectMode ? 'Cancel selection' : 'Select cards to ship'}
          </button>
          {selectMode && (
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={() => setDeliverOpen(true)}
              className="rounded-lg bg-gradient-to-r from-emerald-500 to-green-500 px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
            >
              Request delivery ({selected.size})
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-10 text-center">
          <p className="text-sm font-medium text-white/70">
            Your vault is empty.
          </p>
          <p className="mt-1 text-[13px] text-white/50">
            Open a pack and the card you pull lands here.
          </p>
          <Link
            href="/claw"
            className="mt-4 inline-flex h-10 items-center justify-center rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 px-5 text-sm font-bold text-white transition-opacity hover:opacity-95"
          >
            Open packs
          </Link>
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => {
            const isSelected = selected.has(item.pullId);
            return (
              <div
                key={item.pullId}
                className={cn(
                  'flex flex-col rounded-2xl border bg-white/[0.03] p-3',
                  selectMode && isSelected
                    ? 'border-emerald-400 ring-2 ring-emerald-400/60'
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
                    className="relative block aspect-[3/4] w-full overflow-hidden rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                  >
                    <Image
                      src={item.card.image}
                      alt={item.card.name}
                      fill
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                      className="object-contain"
                    />
                    <span
                      className={cn(
                        'absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border text-[13px] font-bold',
                        isSelected
                          ? 'border-emerald-400 bg-emerald-500 text-white'
                          : 'border-white/40 bg-black/50 text-transparent',
                      )}
                      aria-hidden
                    >
                      ✓
                    </span>
                  </button>
                ) : (
                  <div className="relative aspect-[3/4] w-full overflow-hidden rounded-md">
                    <Image
                      src={item.card.image}
                      alt={item.card.name}
                      fill
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                      className="object-contain"
                    />
                  </div>
                )}
                <p
                  className="mt-2 line-clamp-2 min-h-[2.1rem] text-[12px] font-semibold leading-snug text-white"
                  title={item.card.name}
                >
                  {item.card.name}
                </p>
                <div className="mt-1 flex items-center justify-between text-[11px]">
                  <span className="font-bold uppercase tracking-wider text-white/50">
                    {item.card.rarity}
                  </span>
                  <span className="font-bold text-white">
                    {usd(item.card.marketValue)}
                  </span>
                </div>
                <p
                  className="mt-0.5 truncate text-[11px] text-white/40"
                  title={item.packTitle}
                >
                  from {item.packTitle}
                </p>
                {!selectMode && (
                  <>
                    <button
                      type="button"
                      onClick={() => setConfirmItem(item)}
                      disabled={sellingId !== null}
                      className="mt-2.5 inline-flex h-9 items-center justify-center rounded-lg border border-amber-400/60 bg-amber-400/10 text-[12px] font-bold text-amber-300 transition-colors hover:bg-amber-400/20 disabled:opacity-50"
                    >
                      {sellingId === item.pullId
                        ? 'Selling…'
                        : `Sell for ${usd(item.buyback.amount)} (${item.buyback.percent}%)`}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleShowcase(item)}
                      disabled={showcasingId !== null}
                      title={
                        item.showcased
                          ? 'Remove from profile showcase'
                          : 'Feature on profile'
                      }
                      className={cn(
                        'mt-1.5 inline-flex h-7 w-full items-center justify-center gap-1 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50',
                        item.showcased
                          ? 'border border-yellow-400/50 bg-yellow-400/10 text-yellow-300 hover:bg-yellow-400/20'
                          : 'border border-white/10 bg-white/[0.03] text-white/40 hover:border-white/20 hover:text-white/60',
                      )}
                    >
                      <Star
                        className={cn(
                          'h-3 w-3',
                          item.showcased && 'fill-yellow-300',
                        )}
                      />
                      {showcasingId === item.pullId
                        ? '…'
                        : item.showcased
                          ? 'On profile'
                          : 'Feature on profile'}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-5 text-[12px] text-white/35">
        Sell-back credits your site balance instantly at the flat{' '}
        {FLAT_BUYBACK_PERCENT}% buyback rate. Physical shipping of vaulted cards
        arrives with checkout.
      </p>

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
