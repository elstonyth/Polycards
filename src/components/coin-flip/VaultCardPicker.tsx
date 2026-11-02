'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { Check, Search, X } from 'lucide-react';
import type { VaultItem } from '@/lib/actions/vault-map';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { rm } from '@/lib/format';
import { COIN_FLIP_MAX_CARDS } from '@/lib/coin-flip';
import { Pill } from '@/components/ui/pill';

export function VaultCardPicker({
  items,
  selected,
  onSelect,
  onClose,
}: {
  items: VaultItem[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState(() =>
    selected.filter((id) => items.some((item) => item.pullId === id)),
  );
  const chosen = items.filter((item) => draft.includes(item.pullId));
  const totalCents = chosen.reduce(
    (sum, item) => sum + Math.round((item.card.priceMyr ?? 0) * 100),
    0,
  );
  useModalA11y(panel, true, onClose);
  const visible = items.filter((item) =>
    item.card.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/80 sm:items-center sm:p-6">
      <button
        aria-hidden
        tabIndex={-1}
        className="absolute inset-0"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="coin-vault-title"
        tabIndex={-1}
        className="relative flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-white/15 bg-neutral-950 outline-none sm:max-w-2xl sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-7 sm:pt-7">
          <div>
            <h2
              id="coin-vault-title"
              className="font-display text-2xl font-black"
            >
              Choose from your Vault
            </h2>
            <p className="mt-1 text-sm text-neutral-400">
              Up to {COIN_FLIP_MAX_CARDS} cards ride on one toss.
            </p>
          </div>
          <button
            aria-label="Close Vault picker"
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-neutral-800 hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-white"
            onClick={onClose}
          >
            <X size={19} aria-hidden />
          </button>
        </div>
        <div className="relative mx-5 mt-5 sm:mx-7">
          <Search
            size={17}
            aria-hidden
            className="pointer-events-none absolute left-4 top-3.5 text-neutral-400"
          />
          <input
            type="search"
            aria-label="Search Vault cards"
            placeholder="Search your cards"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-11 w-full rounded-xl border border-white/15 bg-neutral-900 pr-4 pl-11 text-sm outline-none placeholder:text-neutral-400 focus-visible:border-white/60"
          />
        </div>
        <p
          aria-live="polite"
          className="mx-5 mt-3 text-xs text-neutral-400 sm:mx-7"
        >
          {visible.length} {visible.length === 1 ? 'card' : 'cards'} available
        </p>
        <ul className="grid min-h-0 grid-cols-2 gap-2.5 overflow-y-auto overscroll-contain p-5 [color-scheme:dark] [scrollbar-width:thin] min-[360px]:grid-cols-3 sm:grid-cols-4 sm:gap-3 sm:p-7">
          {visible.map((item) => {
            const price = item.card.priceMyr;
            const isSelected = draft.includes(item.pullId);
            const atCapacity =
              !isSelected && draft.length >= COIN_FLIP_MAX_CARDS;
            const image = item.card.slabImage || item.card.image;
            return (
              <li key={item.pullId}>
                <button
                  type="button"
                  disabled={atCapacity}
                  aria-pressed={isSelected}
                  aria-label={`Select ${item.card.name}${price != null ? `, ${rm(price)}` : ''}`}
                  onClick={() =>
                    setDraft((ids) =>
                      ids.includes(item.pullId)
                        ? ids.filter((id) => id !== item.pullId)
                        : [...ids, item.pullId],
                    )
                  }
                  className="group relative flex h-full w-full flex-col rounded-xl border border-white/10 bg-neutral-900 p-2 text-left transition-colors hover:border-white/40 focus-visible:outline-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-45 aria-pressed:border-white aria-pressed:bg-neutral-800 sm:p-2.5"
                >
                  <span className="relative block aspect-[3/4] w-full overflow-hidden">
                    <Image
                      src={image || '/images/app/polycards-card-back.webp'}
                      alt=""
                      fill
                      sizes="(max-width: 640px) 30vw, 150px"
                      unoptimized
                      className="object-contain transition-transform duration-200 motion-safe:group-hover:-translate-y-1"
                    />
                  </span>
                  {isSelected && (
                    <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-white text-black">
                      <Check size={15} aria-hidden />
                    </span>
                  )}
                  <span className="mt-2 line-clamp-2 text-xs font-semibold leading-snug [overflow-wrap:anywhere] sm:text-sm">
                    {item.card.name}
                  </span>
                  <span className="mt-1 text-xs font-semibold tabular-nums text-neutral-200 [overflow-wrap:anywhere] sm:text-sm">
                    {price == null ? 'Value on review' : rm(price)}
                  </span>
                  <span className="mt-1 text-[11px] leading-snug text-neutral-400 sm:text-xs">
                    {atCapacity
                      ? 'Selection limit reached'
                      : item.source === 'gift'
                        ? 'Gift-funded'
                        : item.source === 'bonus'
                          ? 'Bonus-funded'
                          : 'In your Vault'}
                  </span>
                </button>
              </li>
            );
          })}
          {!visible.length && (
            <li className="col-span-full py-12 text-center text-sm text-neutral-400">
              {query
                ? 'No matching cards. Try another name.'
                : 'Your unlocked Vault cards will appear here.'}
            </li>
          )}
        </ul>
        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-white/10 bg-neutral-950 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-7">
          <div aria-live="polite" className="min-w-0 [overflow-wrap:anywhere]">
            <p className="text-sm font-semibold">
              {draft.length} selected · {rm(totalCents / 100)}
            </p>
            <p className="mt-1 text-xs text-neutral-400">
              Final value confirmed on review.
            </p>
          </div>
          {/* With a selection already in place, none is a real choice: tickets alone. */}
          <Pill
            disabled={!draft.length && !selected.length}
            onClick={() => onSelect(draft)}
          >
            {!draft.length && selected.length
              ? 'Clear cards'
              : `Use ${draft.length || ''} ${draft.length === 1 ? 'card' : 'cards'}`}
          </Pill>
        </div>
      </div>
    </div>,
    document.body,
  );
}
