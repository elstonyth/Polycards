'use client';

import { useState } from 'react';
import { IntentLink } from '@/components/IntentLink';
import QtyStepper from '@/components/QtyStepper';
import { pillVariants } from '@/components/ui/pill';
import { ArrowDisc } from '@/components/ui/soft';
import { packHref } from '@/lib/packs-data';
import { cn } from '@/lib/utils';
import type { StagePack } from './contract';

/** Owner decision 5: the quantity stepper shows on desktop
 *  only; phones open one pack and pick the count on the pack page. */
export const STAGE_STEPPER_DESKTOP_ONLY = true;

/** The 1-3 packs the reel opens per spin (as the /slots catalogue). */
const MAX_QTY = 3;

/**
 * The status a pack wears beside its name: a boosted buyback rate.
 * shortcut: duplicates the boost branch of CatalogClient's private
 * StatusBadge (sold out has its own pill here); share it at integration.
 */
function StatusBadge({ pack }: { pack: StagePack }) {
  if (pack.soldOut || !pack.boost || pack.ticket) return null;
  return (
    <span className="rounded-full bg-buyback px-2.5 py-1 text-xs font-bold uppercase leading-none tracking-wide text-white">
      {pack.buybackPercent}% Instant Buyback
    </span>
  );
}

/**
 * The centred pack's facts and action, under the carousel.
 * Phone: name, price, top chase, Open. Desktop adds the category and buyback
 * line and the quantity stepper, as the /slots catalogue's lead card. Sold out
 * keeps the name and price at half strength and puts a full-contrast "Sold
 * out" pill where Open was.
 */
export default function StageInfo({
  pack,
  index,
  count,
  categoryName,
}: {
  pack: StagePack;
  index: number;
  count: number;
  categoryName: string;
}) {
  // Each pack starts at one: a count picked for one pack never carries over.
  const [qty, setQty] = useState({ id: pack.id, n: 1 });
  const n = qty.id === pack.id ? qty.n : 1;
  const setN = (value: number) => setQty({ id: pack.id, n: value });

  return (
    <div className="flex flex-col items-center text-center">
      <div className="flex min-h-7 flex-wrap items-center justify-center gap-x-2.5 gap-y-1">
        <h2
          className={cn(
            'text-lg font-semibold leading-tight text-white lg:font-heading lg:text-[clamp(1.75rem,2.4vw,2.5rem)] lg:font-bold lg:leading-[1.05] lg:tracking-[-0.02em]',
            pack.soldOut && 'opacity-50',
          )}
        >
          {pack.soldOut ? (
            pack.name
          ) : (
            // The name opens the pack too, without a second tab stop beside Open.
            <IntentLink
              href={packHref(pack.id, n)}
              tabIndex={-1}
              className="outline-none hover:text-neutral-200"
            >
              {pack.name}
            </IntentLink>
          )}
        </h2>
        <StatusBadge pack={pack} />
      </div>
      {!pack.ticket && (
        <p className="mt-1.5 hidden text-sm text-neutral-400 lg:block">
          {categoryName} · {pack.buybackPercent}% instant buyback
        </p>
      )}
      <div className="mt-1.5 flex items-baseline gap-3">
        <span
          className={cn(
            'font-heading text-2xl tabular-nums text-white lg:text-3xl',
            pack.soldOut && 'opacity-50',
          )}
        >
          {pack.priceLabel}
        </span>
        {pack.chaseLabel && !pack.soldOut && (
          <span className="text-[11px] uppercase tracking-wide text-neutral-400 lg:text-xs">
            Top chase{' '}
            <span className="font-heading text-sm normal-case tracking-normal text-chase lg:text-base">
              {pack.chaseLabel}
            </span>
          </span>
        )}
      </div>

      <div className="mt-4 flex w-full max-w-sm items-center justify-center gap-2">
        {pack.soldOut ? (
          <span className="flex h-11 w-full max-w-[16rem] items-center justify-center rounded-full bg-white/[0.08] text-sm font-semibold text-white ring-1 ring-white/15">
            Sold out
          </span>
        ) : (
          <>
            <QtyStepper
              qty={n}
              onChange={setN}
              max={MAX_QTY}
              className={cn(STAGE_STEPPER_DESKTOP_ONLY && 'hidden lg:flex')}
            />
            <IntentLink
              href={packHref(pack.id, n)}
              className={cn(
                pillVariants({ variant: 'primary', size: 'md' }),
                'group/open min-w-[10rem] flex-1 justify-between pl-5 pr-1.5 sm:max-w-[16rem]',
              )}
            >
              Open
              <ArrowDisc className="group-hover/open:-translate-y-px group-hover/open:translate-x-0.5 group-hover/open:scale-105 motion-reduce:group-hover/open:transform-none" />
            </IntentLink>
          </>
        )}
      </div>
      <p className="mt-3 text-xs tabular-nums text-neutral-400" aria-hidden>
        {index + 1} / {count}
      </p>
    </div>
  );
}
