'use client';

import { useState, type CSSProperties } from 'react';
import { SlabImage } from '@/components/SlabImage';
import { cn } from '@/lib/utils';
import { initialPriceTick, nextPriceTick } from '@/lib/price-tick';
import { rarityRgb } from '@/lib/rarity';
import { rm, relativeTime } from '@/lib/format';
import type { CardDetailData } from '@/lib/data/cards';
import type { CardSeed } from '@/components/cards/CardDetailOverlay';

/**
 * The card-detail content, rendered by BOTH the overlay (instant, seeded from
 * grid data, `detail` hydrates ≲1s later) and the /card/[handle] page (server
 * `detail` from the first paint). Everything that needs endpoint data (eyebrow,
 * delta badge, trust line) waits for `detail`; name/image/price render from the
 * seed immediately. Context rarity (seed) wins over the endpoint fallback.
 *
 * `entrance` opts into the staggered first-paint choreography and is for the
 * PAGE only. The overlay already animates its whole panel (opacity + scale,
 * 250ms) — turning this on there would run two entrances over each other.
 */
export function CardDetail({
  seed,
  detail,
  buybackPercent = null,
  entrance = false,
}: {
  seed: CardSeed;
  detail: CardDetailData | null;
  buybackPercent?: number | null;
  entrance?: boolean;
}) {
  const rarity = seed.rarity ?? detail?.rarity ?? null;
  const rgb = rarity ? rarityRgb(rarity) : '255,255,255';
  const priceLabel = detail ? rm(detail.marketPriceMyr) : seed.value;

  // Entrance slot helpers — see globals.css "Shared first-paint entrance".
  const rise = entrance ? 'rise-in' : '';
  const at = (i: number): CSSProperties | undefined =>
    entrance ? ({ '--i': i } as CSSProperties) : undefined;

  // Live price pulse — rules and rationale in src/lib/price-tick.ts. State is
  // adjusted during render (the React "adjust state when props change" pattern
  // useCardPrice already uses) rather than in an effect, which this repo's lint
  // rejects.
  const price = detail?.marketPriceMyr ?? null;
  const [tick, setTick] = useState(() => initialPriceTick(seed.handle, price));
  const next = nextPriceTick(tick, seed.handle, price);
  if (next !== tick) setTick(next);

  // 30-day delta from price history (the chart itself was removed — boss doc
  // "Cancel first", 2026-07-14; the badge stays).
  const history = detail?.priceHistory; // stable ref from state; undefined when no detail
  // A 30d delta needs two points — a single-entry history has no change to report.
  const first = history?.[0]?.valueMyr;
  const last = history?.at(-1)?.valueMyr;
  const delta =
    history && history.length >= 2 && first !== undefined && last !== undefined
      ? last - first
      : null;

  return (
    <div className="grid w-full items-center gap-5 md:grid-cols-[minmax(0,420px)_1fr] md:gap-12">
      {/* The slab — the hero. Rarity-tinted glow, STATIC (idle float removed —
          operator 2026-07-18). Phone width is dvh-capped so slab + facts fit
          one viewport (no overlay scrolling).
          `entrance` adds a plain opacity fade and NOTHING else: no scale, no
          drift, and the halo is at full strength on frame one. The float
          (2026-07-18) and the frame's light sweep (2026-07-17) were both cut
          by the operator — this is a one-shot arrival, not their return. */}
      <div
        className={cn(
          'mx-auto w-[min(62vw,26dvh)] max-w-[320px] md:w-full md:max-w-[420px]',
          entrance && 'slab-arrive',
        )}
      >
        <div
          style={{
            filter: `drop-shadow(0 24px 60px rgba(0,0,0,0.7)) drop-shadow(0 0 46px rgba(${rgb},0.28))`,
          }}
        >
          <SlabImage
            src={seed.image}
            slabSrc={detail?.slab_image ?? seed.slabImage}
            rarity={rarity}
            alt={seed.name}
            sizes="(max-width: 768px) 62vw, 420px"
            priority
            className="w-full"
          />
        </div>
      </div>

      {/* Facts — phone sizes sit two steps down the scale so a long graded-
          card name reads as a title, not a wall of display type. */}
      <div className="flex min-w-0 flex-col gap-2.5 md:gap-4">
        {detail && (
          <p
            style={at(0)}
            className={cn(
              rise,
              'text-[11px] font-semibold uppercase tracking-wider text-white/55 md:text-[12px]',
            )}
          >
            {detail.set} · {detail.grader} {detail.grade}
          </p>
        )}
        <h1
          style={at(1)}
          className={cn(
            rise,
            'font-heading text-lg font-bold uppercase leading-[1.15] tracking-tight text-white sm:text-3xl md:text-5xl md:leading-[1.05]',
          )}
        >
          {seed.name}
        </h1>
        {rarity && (
          <span
            className={cn(
              rise,
              'w-fit rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wide md:text-[12px]',
            )}
            style={{
              ...at(2),
              color: `rgb(${rgb})`,
              backgroundColor: `rgba(${rgb},0.12)`,
            }}
          >
            {rarity}
          </span>
        )}

        {/* Value block */}
        <div
          style={at(3)}
          className={cn(rise, 'flex flex-wrap items-end gap-x-4 gap-y-2')}
        >
          {/* `key` remounts on each tick so the pulse re-arms. The tint's
              bleed comes from box-shadow spread (see globals.css), so nothing
              here costs layout. Green up / red down are the money signals. */}
          <p
            key={next.n}
            style={
              next.n > 0
                ? ({
                    '--tick-rgb': next.up ? '47,191,110' : '248,113,113',
                  } as CSSProperties)
                : undefined
            }
            className={cn(
              'font-heading rounded-md text-2xl font-bold tabular-nums text-white md:text-4xl',
              next.n > 0 && 'price-tick',
            )}
          >
            {priceLabel}
            <span className="ml-2 text-sm font-normal text-white/50">est.</span>
          </p>
          {delta !== null && delta !== 0 && (
            <span
              className={
                delta > 0
                  ? 'rounded-md bg-buyback/15 px-2 py-1 text-[12px] font-bold text-buyback-fg'
                  : 'rounded-md bg-red-500/15 px-2 py-1 text-[12px] font-bold text-red-400'
              }
            >
              {delta > 0 ? '▲' : '▼'} {rm(Math.abs(delta))} · 30d
            </span>
          )}
        </div>

        {buybackPercent != null && detail && (
          <p style={at(4)} className={cn(rise, 'text-[13px] text-white/70')}>
            Instant buyback if pulled:{' '}
            <span className="font-bold text-buyback-fg">
              {rm((detail.marketPriceMyr * buybackPercent) / 100)}
            </span>{' '}
            ({buybackPercent}%)
          </p>
        )}

        {detail?.pcSyncedAt && (
          <p style={at(5)} className={cn(rise, 'text-[12px] text-white/50')}>
            Market price · synced {relativeTime(detail.pcSyncedAt)} via
            PriceCharting
          </p>
        )}
      </div>
    </div>
  );
}
