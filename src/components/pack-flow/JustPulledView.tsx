import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { ChartNoAxesColumn } from 'lucide-react';
import { FramedAvatar } from '@/components/FramedAvatar';
import { TicketArt } from '@/components/TicketArt';
import { TierBadge } from '@/components/TierBadge';
import type { RecentFeed, RecentPull } from '@/lib/data/packs';
import { pullTime, rm } from '@/lib/format';
import { ticketCount, type Rarity } from '@/lib/packs-data';
import { isTopRarity, rarityRgb, RARITY_ORDER } from '@/lib/rarity';
import { cn } from '@/lib/utils';
import {
  DRAWER_TABS,
  emptyLine,
  type DrawerTab,
  type StackCard,
} from './drawer-model';
import styles from './drawer.module.css';

const focusRing =
  'outline-none focus-visible:ring-2 focus-visible:ring-white/40';

/** One pull as an index card: the tab (who, tier, value) over the body (the
 *  card, its name, when, the pack). A ticket win has no card to open or
 *  price: its body is not a link and the tab carries the amount. */
function DrawerCard({
  card,
  listForm,
}: {
  card: StackCard<RecentPull>;
  listForm?: boolean;
}) {
  const { item: pull, d, arrive, leave } = card;
  const rgb = rarityRgb(pull.rarity);
  const value = pull.priceMyr != null ? rm(pull.priceMyr) : '—';
  const tickets = pull.tickets != null ? ticketCount(pull.tickets) : null;
  // PullHistory's row label, word for word.
  const label = `${pull.who} pulled ${pull.name} — ${pull.rarity}, ${value}, ${pull.agoLabel}`;
  const avatar = (
    <FramedAvatar
      src={pull.avatar}
      initial={pull.who.charAt(0).toUpperCase() || '?'}
      frameSrc={pull.frame}
      size={28}
    />
  );
  const info = (
    <span className="flex min-w-0 flex-col gap-1.5 pt-0.5">
      <span className="line-clamp-2 font-heading text-[19px] leading-[1.12] text-white [overflow-wrap:anywhere] lg:text-3xl">
        {tickets ?? pull.name}
      </span>
      <span className="text-xs text-neutral-400 tabular-nums lg:text-sm">
        <time dateTime={pull.rolledAt}>{pullTime(pull.rolledAt)}</time>
      </span>
      <span className="flex items-center gap-1.5 text-xs text-neutral-400 lg:text-sm">
        <Image
          src={pull.packIcon}
          alt=""
          width={16}
          height={27}
          className="h-[27px] w-4 shrink-0 object-contain"
        />
        · {pull.packName}
      </span>
    </span>
  );
  return (
    <li
      data-jp-card=""
      data-id={pull.id}
      data-d={d}
      data-arrive={arrive ? '' : undefined}
      data-leave={leave ? '' : undefined}
      aria-hidden={leave || undefined}
      // In the drawer only the front card is reachable: the tabs behind it
      // are covered, and a leaving card is on its way out.
      inert={listForm === false && (d > 0 || leave) ? true : undefined}
      className={cn(styles.card, isTopRarity(pull.rarity) && styles.chase)}
      style={{ '--t': rgb } as CSSProperties}
    >
      <div className={styles.tab}>
        {pull.profileHandle ? (
          <Link
            href={`/profile/${pull.profileHandle}?tab=activity`}
            prefetch={false}
            aria-label={`View ${pull.who}'s activity`}
            className={cn('shrink-0 rounded-full', focusRing)}
          >
            {avatar}
          </Link>
        ) : (
          avatar
        )}
        <span className="min-w-0 truncate text-[13px] font-semibold text-white lg:text-[15px]">
          {pull.who}
        </span>
        <TierBadge rarity={pull.rarity} />
        <span className="ml-auto whitespace-nowrap pl-2 font-heading text-[15px] leading-none text-white tabular-nums lg:text-xl">
          {tickets ?? value}
        </span>
      </div>
      {tickets ? (
        <div className={styles.body}>
          <span className={cn(styles.art, 'flex items-center justify-center')}>
            <TicketArt width={96} className="h-auto w-full" />
          </span>
          {info}
        </div>
      ) : (
        <Link
          href={`/card/${pull.handle}`}
          // One pod render per card otherwise.
          prefetch={false}
          aria-label={label}
          className={cn(styles.body, focusRing)}
        >
          <Image
            src={pull.image}
            alt=""
            width={150}
            height={210}
            sizes="(min-width: 1024px) 150px, 96px"
            data-jp-art=""
            className={styles.art}
          />
          {info}
        </Link>
      )}
    </li>
  );
}

/**
 * The Just Pulled section's own part:
 * the heading with LIVE, the "packs without" counters, the tier filter, and
 * the drawer of pulls (Stats opens its chart in a sheet). No hooks: the server
 * renders it once from the page's feed (the drawer at rest, and the plain
 * list without JavaScript or under reduced motion), and the lazily loaded
 * JustPulledDrawer renders it again live.
 */
export function JustPulledView({
  cards,
  stackKey,
  drought,
  noun,
  tab,
  onTab,
  pending = false,
  moved,
  listForm,
}: {
  cards: StackCard<RecentPull>[];
  /** Re-keys the stack, so a refill steps in afresh. */
  stackKey: string;
  drought: RecentFeed['drought'];
  noun: 'pack' | 'capsule';
  tab: DrawerTab;
  /** Absent on the server: the tabs wait for the drawer's code. */
  onTab?: (tab: DrawerTab) => void;
  /** A tab's pulls are on their way: the drawer dims, as today's list does. */
  pending?: boolean;
  /** Counters whose number changed since the page loaded: they re-land. */
  moved?: ReadonlySet<Rarity>;
  /** Reduced motion: the plain list (true), or the drawer (false). Unknown
   *  on the server, where nothing is made unreachable. */
  listForm?: boolean;
}) {
  const droughts = RARITY_ORDER.flatMap((r) => {
    const n = drought[r];
    return n == null ? [] : [[r, n] as const];
  });
  return (
    <section
      aria-labelledby="jp-heading"
      className={cn('w-full', styles.section)}
    >
      <div className="px-fluid lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)] lg:items-start lg:gap-x-12 lg:gap-y-5">
        <div className="flex items-center gap-3 lg:col-start-1 lg:row-start-1 lg:self-end">
          <h2
            id="jp-heading"
            className="font-heading text-2xl text-white lg:text-[56px] lg:leading-none"
          >
            JUST PULLED
          </h2>
          <span className="flex items-center gap-1.5 rounded-full bg-neutral-800 px-2.5 py-1 text-[11px] font-semibold text-white">
            {/* White dot: LIVE is not a money signal (Signal Rule). */}
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none"
              aria-hidden
            />
            LIVE
          </span>
        </div>

        {droughts.length > 0 && (
          <div
            className={cn(
              'mt-4 grid grid-cols-2 gap-2.5 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-0',
              styles.counters,
            )}
          >
            {droughts.map(([r, n]) => {
              const rgb = rarityRgb(r);
              return (
                <div
                  key={r}
                  data-jp-counter=""
                  className={cn(
                    'rounded-2xl border bg-neutral-900/90 px-3.5 pt-3 pb-3.5 lg:px-5 lg:pt-4 lg:pb-[18px]',
                    styles.counter,
                  )}
                  style={{ '--t': rgb } as CSSProperties}
                >
                  <p
                    className={cn(
                      'font-heading text-[56px] leading-none tracking-[-0.02em] text-white tabular-nums lg:text-[64px]',
                      styles.count,
                    )}
                  >
                    <span
                      key={n}
                      className={cn(
                        'inline-block',
                        moved?.has(r) &&
                          'pull-row-in motion-reduce:animate-none',
                      )}
                    >
                      {n}
                    </span>
                  </p>
                  <p
                    className={cn(
                      'mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-neutral-400 lg:text-[13px]',
                      styles.countLabel,
                    )}
                  >
                    {noun}s without <TierBadge rarity={r} />
                  </p>
                </div>
              );
            })}
          </div>
        )}

        <div
          role="group"
          aria-label="Filter pulls by tier"
          className={cn(
            'mt-3 grid grid-cols-[repeat(4,minmax(0,1fr))_2.75rem] gap-1 rounded-full border border-white/10 bg-neutral-900/90 p-1 lg:col-start-1 lg:row-start-2 lg:mt-0 lg:max-w-[560px]',
            styles.filter,
          )}
        >
          {DRAWER_TABS.map((t) => (
            <button
              key={t}
              type="button"
              // Stats is not a filter: it opens the chart's sheet.
              aria-pressed={t === 'Stats' ? undefined : tab === t}
              aria-haspopup={t === 'Stats' ? 'dialog' : undefined}
              aria-label={t === 'Stats' ? 'Stats' : undefined}
              onClick={onTab ? () => onTab(t) : undefined}
              className={cn(
                'flex min-h-10 min-w-0 items-center justify-center gap-1 rounded-full px-1 text-[11px] font-semibold transition-colors sm:text-[12px]',
                focusRing,
                tab === t
                  ? 'bg-neutral-700 text-white'
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
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        styles.dot,
                      )}
                      style={{ '--t': rarityRgb(t) } as CSSProperties}
                    />
                  )}
                  {t}
                </>
              )}
            </button>
          ))}
        </div>
      </div>

      <div
        className={cn(
          // w-full: the section is a flex column, where auto margins would
          // shrink the wrap to its absolutely placed cards (no width)
          'px-fluid mt-[18px] w-full lg:mx-auto lg:mt-10 lg:max-w-[820px] lg:px-0',
          styles.drawerWrap,
        )}
      >
        <div data-jp-drawer="" aria-busy={pending} className={styles.box}>
          {cards.length === 0 ? (
            <p data-jp-empty="" className={styles.empty}>
              {emptyLine(tab, noun)}
            </p>
          ) : (
            <ol key={stackKey} className={styles.stack}>
              {cards.map((c) => (
                <DrawerCard key={c.item.id} card={c} listForm={listForm} />
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
