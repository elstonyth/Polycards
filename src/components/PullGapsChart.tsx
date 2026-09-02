'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { FramedAvatar } from '@/components/FramedAvatar';
import { TierBadge } from '@/components/TierBadge';
import { rarityRgb, TOP_RARITIES } from '@/lib/rarity';
import { gapScale, gapPercent } from '@/lib/pull-gaps';
import { pullTime } from '@/lib/format';
import type { Rarity } from '@/lib/packs-data';
import type { PullGaps } from '@/lib/data/packs';

/**
 * The pull-history STATS tab (showgo's histogram sheet): for one chase tier,
 * one horizontal bar per hit — how many pulls it took since the previous hit,
 * and who landed it — under the current drought bar (no winner yet), against
 * a dashed reference line at the expected gap (1 / the pack's published rate,
 * or the observed mean when there is no rate) with the axis laid out in its
 * multiples.
 *
 * Data comes from /api/pull-gaps — fetched when the tab opens, on a tier
 * toggle, and when `refreshKey` (the panel's drought counters) moves, never
 * on a timer. The previous tier's chart stays up, dimmed, until the next one
 * lands.
 *
 * Color (dataviz + Signal Rule): winners' bars are ONE neutral series; the
 * tier hue marks only the drought bar (the thing being chased), the reference
 * line and its tick. Text stays in text tokens.
 */
const ROW = 'h-9';

export function PullGapsChart({
  packSlug,
  refreshKey,
}: {
  packSlug?: string;
  /** Any change refetches — the panel passes its drought counters. */
  refreshKey: string;
}) {
  const [tier, setTier] = useState<Rarity>(TOP_RARITIES[0]!);
  const [data, setData] = useState<PullGaps | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const q = new URLSearchParams({ rarity: tier });
    if (packSlug) q.set('pack_id', packSlug);
    fetch(`/api/pull-gaps?${q.toString()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<PullGaps | null>) : null))
      .then((body) => {
        if (!active) return;
        if (body) setData(body);
        setFailed(!body);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [tier, packSlug, refreshKey]);

  const rgb = rarityRgb(tier);
  const pending = data?.rarity !== tier;
  const scale = data
    ? gapScale(data.expected, data.avg, [
        data.current,
        ...data.hits.map((h) => h.gap),
      ])
    : null;
  const linePos =
    scale && scale.line != null ? (scale.line / scale.max) * 100 : null;
  const lineStyle: CSSProperties = { borderColor: `rgba(${rgb}, 0.75)` };

  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4">
      {/* Header — rate | expected gap, last-20 mean, and the tier toggle */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-white">
            <TierBadge rarity={tier} />
            {data?.pct != null && (
              <>
                <span className="font-semibold tabular-nums">{data.pct}%</span>
                <span aria-hidden className="text-neutral-500">
                  |
                </span>
              </>
            )}
            <span className="text-neutral-400">Avg:</span>
            <span className="font-heading text-base leading-none tabular-nums">
              {scale?.line != null ? Math.round(scale.line) : '—'}
            </span>
            <span className="text-neutral-400">draws</span>
          </p>
          <p className="mt-1.5 text-[12px] text-neutral-400">
            Last 20 {tier} avg:{' '}
            <span className="font-semibold tabular-nums text-neutral-200">
              {data?.last20 != null ? Math.round(data.last20) : '—'}
            </span>{' '}
            draws
          </p>
        </div>
        <div
          role="group"
          aria-label="Chart tier"
          className="grid grid-cols-3 gap-1 rounded-full border border-white/10 bg-neutral-950 p-1"
        >
          {TOP_RARITIES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={tier === r}
              onClick={() => setTier(r)}
              className={cn(
                'rounded-full px-2.5 py-1.5 text-[12px] font-semibold transition-colors',
                tier === r
                  ? 'bg-neutral-50 text-neutral-950'
                  : 'text-neutral-400 hover:text-white',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {failed && !data ? (
        <p className="py-10 text-center text-[13px] text-white/60">
          Stats unavailable right now — the feed still works.
        </p>
      ) : !data || !scale ? (
        <ol aria-busy className="mt-5 flex flex-col gap-2" aria-label="Loading">
          {[52, 28, 74, 16, 40].map((w, i) => (
            <li key={i} className={cn(ROW, 'flex items-center gap-2')}>
              <span className="h-7 w-7 animate-pulse rounded-full bg-white/10 motion-reduce:animate-none" />
              <span className="w-16 shrink-0" />
              <span
                className="h-6 animate-pulse rounded-r bg-white/10 motion-reduce:animate-none"
                style={{ width: `${w}%` }}
              />
            </li>
          ))}
        </ol>
      ) : (
        <div
          aria-busy={pending}
          className={cn(
            'mt-4 transition-opacity duration-300',
            pending && 'opacity-50',
          )}
        >
          {/* ▼ marker over the reference line */}
          <div className="relative ml-[6.5rem] h-3 text-[10px] leading-none">
            {linePos != null && (
              <span
                aria-hidden
                className="absolute top-0 -translate-x-1/2"
                style={{ left: `${linePos}%`, color: `rgb(${rgb})` }}
              >
                ▼
              </span>
            )}
          </div>

          <ol key={tier} className="flex flex-col gap-2">
            {/* The drought bar: pulls since the newest hit, nobody's yet. */}
            <BarRow
              i={0}
              label={<TierBadge rarity={tier} />}
              gap={data.current}
              max={scale.max}
              linePos={linePos}
              lineStyle={lineStyle}
              fill={`rgb(${rgb})`}
              title={`${data.current} pulls since the last ${tier}`}
              emphasis
            />
            {data.hits.map((h, i) => (
              <BarRow
                key={h.id}
                i={i + 1}
                label={
                  <>
                    <FramedAvatar
                      src={h.avatar}
                      initial={h.who.charAt(0).toUpperCase() || '?'}
                      frameSrc={h.frame}
                      size={28}
                    />
                    <span className="truncate text-[12px] font-semibold text-white">
                      {h.who}
                    </span>
                  </>
                }
                gap={h.gap}
                max={scale.max}
                linePos={linePos}
                lineStyle={lineStyle}
                fill="rgba(255, 255, 255, 0.72)"
                title={`${h.who} · ${pullTime(h.rolledAt)} · ${h.gap} pulls since the previous ${tier}`}
              />
            ))}
          </ol>

          {/* Axis — ticks in multiples of the reference gap */}
          <div className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 text-[12px] tabular-nums text-neutral-500">
            <span>Winners</span>
            <div className="relative h-5">
              {scale.ticks.map((t, i) => {
                const last = i === scale.ticks.length - 1;
                const isLine = scale.line != null && t === scale.ticks[1];
                return (
                  <span
                    key={t}
                    className={cn(
                      'absolute top-0',
                      i === 0
                        ? ''
                        : last
                          ? '-translate-x-full'
                          : '-translate-x-1/2',
                      isLine ? 'font-semibold' : '',
                    )}
                    style={{
                      left: `${(t / scale.max) * 100}%`,
                      color: isLine ? `rgb(${rgb})` : undefined,
                    }}
                  >
                    {isLine && (
                      <span aria-hidden className="mr-0.5 text-[10px]">
                        ▲
                      </span>
                    )}
                    {t}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BarRow({
  i,
  label,
  gap,
  max,
  linePos,
  lineStyle,
  fill,
  title,
  emphasis = false,
}: {
  i: number;
  label: React.ReactNode;
  gap: number;
  max: number;
  linePos: number | null;
  lineStyle: CSSProperties;
  fill: string;
  title: string;
  emphasis?: boolean;
}) {
  return (
    <li
      title={title}
      aria-label={title}
      className={cn(
        ROW,
        'grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-2',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">{label}</span>
      {/* The bar column. The dashed reference line is drawn per row and
          extended by the row gap so it reads as one continuous line. */}
      <span className="relative flex h-full items-center">
        {linePos != null && (
          <span
            aria-hidden
            className="pointer-events-none absolute -top-2 -bottom-2 border-l border-dashed"
            style={{ left: `${linePos}%`, ...lineStyle }}
          />
        )}
        <span
          className="bar-grow h-6 shrink-0 rounded-r motion-reduce:animate-none"
          style={
            {
              width: `${gapPercent(gap, max)}%`,
              backgroundColor: fill,
              '--i': i,
            } as CSSProperties
          }
        />
        <span
          className={cn(
            'ml-2 shrink-0 text-[13px] tabular-nums',
            emphasis ? 'font-bold text-white' : 'text-neutral-200',
          )}
        >
          {gap}
        </span>
      </span>
    </li>
  );
}
