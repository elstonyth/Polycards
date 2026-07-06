'use client';

import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { SlabImage } from '@/components/SlabImage';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { rarityRgb } from '@/lib/rarity';
import { rm, relativeTime } from '@/lib/format';
import type { CardDetailData } from '@/lib/data/cards';
import type { CardSeed } from '@/components/cards/CardDetailOverlay';

/**
 * The card-detail content, rendered by BOTH the overlay (instant, seeded from
 * grid data, `detail` hydrates ≲1s later) and the /card/[handle] page (server
 * `detail` from the first paint). Everything that needs endpoint data (eyebrow,
 * sparkline, trust line) waits for `detail`; name/image/price render from the
 * seed immediately. Context rarity (seed) wins over the endpoint fallback.
 */
export function CardDetail({
  seed,
  detail,
  buybackPercent = null,
}: {
  seed: CardSeed;
  detail: CardDetailData | null;
  buybackPercent?: number | null;
}) {
  const reduced = usePrefersReducedMotion();
  const rarity = seed.rarity ?? detail?.rarity ?? null;
  const rgb = rarity ? rarityRgb(rarity) : '255,255,255';
  const priceLabel = detail ? rm(detail.marketPriceMyr) : seed.value;

  // Pointer-tracked 3D tilt — pure presentation, off under reduced motion.
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reduced) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTilt({
      x: ((e.clientY - r.top) / r.height - 0.5) * -10,
      y: ((e.clientX - r.left) / r.width - 0.5) * 10,
    });
  };

  // Real 30-day sparkline from history (hidden with <2 points).
  const history = detail?.priceHistory ?? [];
  const spark = useMemo(() => {
    if (history.length < 2) return null;
    const pts = history.map((p) => p.valueMyr);
    const max = Math.max(...pts);
    const min = Math.min(...pts);
    return pts
      .map(
        (p, i) =>
          `${(i / (pts.length - 1)) * 100},${100 - ((p - min) / (max - min || 1)) * 100}`,
      )
      .join(' ');
  }, [history]);
  const first = history[0]?.valueMyr;
  const last = history[history.length - 1]?.valueMyr;
  const delta = first !== undefined && last !== undefined ? last - first : null;

  return (
    <div className="grid w-full items-center gap-8 md:grid-cols-[minmax(0,420px)_1fr] md:gap-12">
      {/* The slab — the hero. Rarity-tinted glow + idle float + pointer tilt. */}
      <motion.div
        animate={reduced ? undefined : { y: [0, -6, 0] }}
        transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
        className="mx-auto w-[70vw] max-w-[320px] md:w-full md:max-w-[420px]"
      >
        <div
          onPointerMove={onMove}
          onPointerLeave={() => setTilt({ x: 0, y: 0 })}
          style={{
            transform: `perspective(1100px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
            transition: 'transform 0.15s ease-out',
            filter: `drop-shadow(0 24px 60px rgba(0,0,0,0.7)) drop-shadow(0 0 46px rgba(${rgb},0.28))`,
          }}
        >
          <SlabImage
            src={seed.image}
            alt={seed.name}
            sizes="(max-width: 768px) 70vw, 420px"
            priority
            className="w-full"
          />
        </div>
      </motion.div>

      {/* Facts */}
      <div className="flex min-w-0 flex-col gap-4">
        {detail && (
          <p className="text-[12px] font-semibold uppercase tracking-wider text-white/55">
            {detail.set} · {detail.grader} {detail.grade}
          </p>
        )}
        <h1 className="font-heading text-3xl font-bold uppercase leading-[1.05] tracking-tight text-white sm:text-5xl">
          {seed.name}
        </h1>
        {rarity && (
          <span
            className="w-fit rounded-full px-3 py-1 text-[12px] font-bold uppercase tracking-wide"
            style={{
              color: `rgb(${rgb})`,
              backgroundColor: `rgba(${rgb},0.12)`,
            }}
          >
            {rarity}
          </span>
        )}

        {/* Value block */}
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <p className="font-heading text-4xl font-bold tabular-nums text-white">
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
          <p className="text-[13px] text-white/70">
            Instant buyback if pulled:{' '}
            <span className="font-bold text-buyback-fg">
              {rm((detail.marketPriceMyr * buybackPercent) / 100)}
            </span>{' '}
            ({buybackPercent}%)
          </p>
        )}

        {spark && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
              className="h-20 w-full"
            >
              <polyline
                points={spark}
                fill="none"
                stroke={`rgb(${rgb})`}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>
        )}

        {detail?.pcSyncedAt && (
          <p className="text-[12px] text-white/50">
            Market price · synced {relativeTime(detail.pcSyncedAt)} via
            PriceCharting
          </p>
        )}
      </div>
    </div>
  );
}
