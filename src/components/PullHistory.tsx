'use client';

import Link from 'next/link';
import { useState, type CSSProperties } from 'react';
import { ChartNoAxesColumn } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLiveRecentPulls } from '@/lib/use-recent-pulls';
import { FramedAvatar } from '@/components/FramedAvatar';
import { SlabImage } from '@/components/SlabImage';
import { TierBadge } from '@/components/TierBadge';
import { PullGapsChart } from '@/components/PullGapsChart';
import {
  isTopRarity,
  rarityRgb,
  RARITY_ORDER,
  TOP_RARITIES,
} from '@/lib/rarity';
import { pullTime } from '@/lib/format';
import type { Rarity } from '@/lib/packs-data';
import type { RecentFeed, RecentPull } from '@/lib/data/packs';

/**
 * The pull-history panel (operator ask 2026-09-02, after showgo's HISTORY
 * sheet): drought counters ("303 packs without IMMORTAL"), a tier filter, and
 * the live row feed — the puller's framed avatar and name, when, the slab,
 * the card, its tier badge and value. One component for both the global feed
 * (home) and a pack's own history (pack detail, via `packSlug`); polling and
 * the tier refetch live in useLiveRecentPulls.
 *
 * Motion is DOM-insertion driven, not state driven: every row carries the
 * `pull-row-in` entrance, and because rows are keyed by pull id a poll that
 * prepends one pull inserts exactly one node — the others keep their keys and
 * never re-run. A tab switch re-keys the list so the new tier staggers in;
 * the drought numeral is keyed on its value so a changed count re-lands.
 * Everything is animate-none under reduced motion.
 *
 * Color obeys the Signal Rule: chrome is neutral; the tier hue appears only on
 * the tier badge, the tab dot, the counter it describes, and — Glow Is
 * Earned — the border/glow of a chase-tier row.
 */
/** The filter tabs, plus the stats chart (showgo's histogram sheet) as the
 *  last, icon-only tab. */
type Tab = 'All' | Rarity | 'Stats';
const TABS: readonly Tab[] = ['All', ...TOP_RARITIES, 'Stats'];

function Row({
  pull,
  showPack,
  onSelect,
}: {
  pull: RecentPull;
  showPack: boolean;
  onSelect?: (pull: RecentPull) => void;
}) {
  const rgb = rarityRgb(pull.rarity);
  const top = isTopRarity(pull.rarity);
  // Chase-tier rows wear their own hue — the glow is inherited from the pull.
  const style = top
    ? {
        borderColor: `rgba(${rgb}, 0.45)`,
        boxShadow: `0 0 24px -10px rgba(${rgb}, 0.55)`,
      }
    : undefined;
  // The label carries EVERYTHING sighted users see in the row — an aria-label
  // REPLACES the content for SR users.
  const label = `${pull.who} pulled ${pull.name} — ${pull.rarity}, ${pull.value}, ${pull.agoLabel}`;
  // No ring-offset: both controls now sit INSIDE the neutral-900 row (which
  // goes neutral-800 on hover), where the old page-ground offset color drew a
  // dark band around the ring.
  const focusRing =
    'outline-none focus-visible:ring-2 focus-visible:ring-white/40';
  const cardClass = cn(
    'flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left @xs:gap-3',
    focusRing,
  );
  const avatar = (
    <FramedAvatar
      src={pull.avatar}
      initial={pull.who.charAt(0).toUpperCase() || '?'}
      frameSrc={pull.frame}
      size={40}
    />
  );
  const inner = (
    <>
      {/* Name + tier badge (showgo's name-then-chip lockup), time under it.
          The pack label only fits on wider containers — on a phone it
          truncated to "Silver…" beside a clipped value. */}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="truncate text-sm font-semibold text-white">
            {pull.who}
          </span>
          {/* Wraps under the name when the two don't fit side by side (a long
              name on a 360-412px phone) instead of running under the slab
              thumb. Below a 320px container it is dropped: the ~60px left for
              this column can't hold "UNCOMMON". */}
          <span className="hidden @xs:contents">
            <TierBadge rarity={pull.rarity} />
          </span>
        </span>
        {/* Wraps rather than truncates: "02 Sep, 04:48:26 AM" needs ~150px and a
            360px phone gives this column ~80px — an ellipsised time reads as
            broken, two short lines don't. */}
        <span className="block text-[12px] text-neutral-400 tabular-nums">
          <time dateTime={pull.rolledAt}>{pullTime(pull.rolledAt)}</time>
          {showPack && (
            <>
              {/* The space sits OUTSIDE the nowrap span so the line may break
                  before "· Pack" — inside it, the break moved to before "AM". */}{' '}
              <span className="hidden whitespace-nowrap @sm:inline">
                · {pull.packName}
              </span>
            </>
          )}
        </span>
      </span>
      <SlabImage
        src={pull.image}
        slabSrc={pull.slabImage}
        alt=""
        sizes="40px"
        className="w-9 shrink-0"
      />
      {/* Card name over the value — the value owns the right edge and never
          wraps; the card name is what truncates. The column is FIXED-width
          (not sized to its content) so it, and the slab thumb beside it, sit
          at the same x on every row instead of each row shifting with its own
          card name. Each width step holds a six-figure "RM 184,828.54" at
          that step's font size; seven figures would spill left over the
          thumb. */}
      <span className="flex w-[6.5rem] shrink-0 flex-col items-end gap-1 @xs:w-[7.25rem] @sm:w-[7.75rem]">
        {/* Two lines, not an ellipsis: "Pretend Comedian Pikachu #…" cut to
            one line hid the very words that name the card. overflow-wrap
            keeps a single long token inside the column. */}
        <span className="line-clamp-2 max-w-full text-right text-[11px] leading-tight text-neutral-300 [overflow-wrap:anywhere]">
          {pull.name}
        </span>
        <span className="whitespace-nowrap font-heading text-[13px] leading-none text-white tabular-nums @xs:text-[15px] @sm:text-base">
          {pull.value}
        </span>
      </span>
    </>
  );
  // The chrome lives on the row CONTAINER, not on the card control: the
  // avatar is its own link (to the puller's activity) and one interactive
  // element may not nest inside another. :active still lands the press-scale
  // — it applies to the pressed element's ancestors too.
  return (
    <div
      style={style}
      className={cn(
        'flex w-full items-center gap-2 rounded-xl border bg-neutral-900 px-3 py-2.5 @xs:gap-3',
        'transition-[background-color,transform] hover:bg-neutral-800 active:scale-[0.99]',
        'motion-reduce:transition-none motion-reduce:active:scale-100',
        !top && 'border-white/10',
      )}
    >
      {pull.profileHandle ? (
        <Link
          href={`/profile/${pull.profileHandle}?tab=activity`}
          aria-label={`View ${pull.who}'s activity`}
          // p-0.5/-m-0.5: the 40px face is the smallest control on the row, and
          // a bare 40px box misses the 44px tap target DESIGN.md asks for. The
          // padding buys the 4px; the negative margin keeps the row's geometry
          // exactly where it was.
          className={cn(
            '-m-0.5 shrink-0 rounded-full p-0.5',
            'transition-opacity hover:opacity-75 motion-reduce:transition-none',
            focusRing,
          )}
        >
          {avatar}
        </Link>
      ) : null}
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(pull)}
          aria-label={label}
          className={cardClass}
        >
          {/* A row with no public profile (anonymised, or the reel's own "You"
              rows) keeps its face INSIDE the card control — before this
              change that 40px opened the card, and a link-less span sitting
              outside would have turned it into dead space. */}
          {!pull.profileHandle && avatar}
          {inner}
        </button>
      ) : (
        <Link
          href={`/card/${pull.handle}`}
          aria-label={label}
          className={cardClass}
        >
          {!pull.profileHandle && avatar}
          {inner}
        </Link>
      )}
    </div>
  );
}

export function PullHistory({
  initial,
  packSlug,
  onSelect,
}: {
  initial: RecentFeed;
  /** Scope to one pack's history; omit for the global feed (rows then also
   *  name their pack). */
  packSlug?: string;
  /** Row tap handler (the pack page opens its card overlay); absent = the row
   *  links to /card/[handle]. */
  onSelect?: (pull: RecentPull) => void;
}) {
  const [tab, setTab] = useState<Tab>('All');
  const { pulls, drought, pending, shownScope } = useLiveRecentPulls(
    initial,
    packSlug,
    tab === 'All' || tab === 'Stats' ? null : tab,
  );
  const droughts = RARITY_ORDER.flatMap((r) => {
    const n = drought[r];
    return n == null ? [] : [[r, n] as const];
  });

  return (
    <div className="@container flex flex-col gap-4">
      {droughts.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {droughts.map(([r, n]) => {
            const rgb = rarityRgb(r);
            return (
              <div
                key={r}
                className="rounded-2xl border bg-neutral-900 px-4 py-3"
                style={{
                  borderColor: `rgba(${rgb}, 0.4)`,
                  boxShadow: `inset 0 -28px 40px -36px rgba(${rgb}, 0.7)`,
                }}
              >
                <p className="font-heading text-3xl leading-none text-white tabular-nums">
                  <span
                    key={n}
                    className="pull-row-in inline-block motion-reduce:animate-none"
                  >
                    {n}
                  </span>
                </p>
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-neutral-400">
                  packs without <TierBadge rarity={r} />
                </p>
              </div>
            );
          })}
        </div>
      )}

      <div
        role="group"
        aria-label="Filter pulls by tier"
        // Below a 320px container (iPhone SE) five equal columns can't hold
        // "Legendary", so the strip scrolls sideways instead of bleeding into
        // its neighbours; from @xs up it is the equal-column grid.
        className="flex gap-1 overflow-x-auto rounded-full border border-white/10 bg-neutral-900 p-1 @xs:grid @xs:grid-cols-[repeat(4,minmax(0,1fr))_auto] @xs:overflow-visible @2xl:max-w-lg [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            aria-label={t === 'Stats' ? 'Stats' : undefined}
            onClick={() => setTab(t)}
            // 11px under a 384px container is a deliberate step below the
            // 12px Label token: five tabs share ~300px at 360-wide phones
            // and "Legendary" doesn't fit at 12px.
            className={cn(
              'flex min-h-10 shrink-0 items-center justify-center gap-1 rounded-full px-1.5 text-[11px] font-semibold transition-colors @xs:px-1 @sm:text-[12px]',
              'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
              t === 'Stats' && 'w-11',
              tab === t
                ? 'bg-neutral-50 text-neutral-950'
                : 'text-neutral-400 hover:text-white',
            )}
          >
            {t === 'Stats' ? (
              <ChartNoAxesColumn className="h-4 w-4" aria-hidden />
            ) : (
              <>
                {t !== 'All' && (
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: `rgb(${rarityRgb(t)})` }}
                  />
                )}
                {t}
              </>
            )}
          </button>
        ))}
      </div>

      {tab === 'Stats' ? (
        // Re-fetches when a drought counter moves — a new pull landed.
        <PullGapsChart
          packSlug={packSlug}
          refreshKey={JSON.stringify(drought)}
        />
      ) : (
        <div
          aria-busy={pending}
          className={cn(
            'transition-opacity duration-300',
            pending && 'opacity-50',
          )}
        >
          {pulls.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center text-[13px] text-white/60">
              {tab === 'All'
                ? 'No pulls yet — be the first to open a pack.'
                : `No ${tab} pulls yet — the next rip could be the one.`}
            </div>
          ) : (
            // Keyed on the scope whose rows are on screen, NOT the tab: the
            // list re-enters once, when the new tier's rows land. Keyed on
            // the tab it replayed the old rows first, then the new ones.
            <ol
              key={shownScope}
              // grid-cols-1: without an explicit minmax(0,1fr) track the
              // implicit `auto` column grows to the rows' nowrap min-content
              // (time · pack · value) and the whole page pans sideways on phones.
              className="grid grid-cols-1 gap-2 @3xl:grid-cols-2"
            >
              {pulls.map((pull, i) => (
                <li
                  key={pull.id}
                  className="pull-row-in motion-reduce:animate-none"
                  style={{ '--i': i } as CSSProperties}
                >
                  <Row pull={pull} showPack={!packSlug} onSelect={onSelect} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
