'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AccountHeader, StatCards } from '@/components/account/ui';
import { AddCreditsPanel } from '@/components/account/AddCreditsPanel';
import { usd } from '@/lib/format';
import {
  sellBackPull,
  type VaultItem,
  type VaultResult,
} from '@/lib/actions/vault';
import { FLAT_BUYBACK_PERCENT } from '@/app/claw/packs-data';

// The customer's vault: every pulled card still held, each with a sell-back
// offer (current FMV × the flat buyback rate — the server quotes the percent).
// Selling removes the card here and credits the site balance shown at the top.
export default function VaultClient({ initial }: { initial: VaultResult }) {
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

  const vaultValue = items.reduce((sum, i) => sum + i.card.marketValue, 0);

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
          <p className="mt-1 text-[13px] text-white/45">
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
          {items.map((item) => (
            <div
              key={item.pullId}
              className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-3"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.card.image}
                alt={item.card.name}
                loading="lazy"
                className="aspect-[3/4] w-full rounded-md object-contain"
              />
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
              <button
                type="button"
                onClick={() => sell(item)}
                disabled={sellingId !== null}
                className="mt-2.5 inline-flex h-9 items-center justify-center rounded-lg border border-amber-400/60 bg-amber-400/10 text-[12px] font-bold text-amber-300 transition-colors hover:bg-amber-400/20 disabled:opacity-50"
              >
                {sellingId === item.pullId
                  ? 'Selling…'
                  : `Sell for ${usd(item.buyback.amount)} (${item.buyback.percent}%)`}
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="mt-5 text-[12px] text-white/35">
        Sell-back credits your site balance instantly at the flat{' '}
        {FLAT_BUYBACK_PERCENT}% buyback rate. Physical shipping of vaulted cards
        arrives with checkout.
      </p>
    </>
  );
}
