'use client';

import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Coins, Gem, History, Percent } from 'lucide-react';
import { Pill } from '@/components/ui/pill';
import { ArrowDisc } from '@/components/ui/soft';
import { rm } from '@/lib/format';
import { isTicketPack, packFacts, type PackCard } from '@/lib/packs-data';
import { pullOddsOf } from '@/lib/pack-tiers';
import { rarityRgb } from '@/lib/rarity';
import { isPokemonPack } from '@/lib/resolve-card-pokemon';
import type { PackDetail } from '@/lib/data/packs';
import type { PackBackDetails } from '@/components/pack-3d/pack-print';
import { usePackBuy } from '@/app/slots/[slug]/use-pack-buy';
import { PackBuyControls } from '@/app/slots/[slug]/PackBuyControls';
import { PoolByRarity } from '@/app/slots/[slug]/PoolByRarity';
import {
  PackCardOverlay,
  PackPullOdds,
  PackRecentPulls,
  usePackCardOverlay,
} from '@/app/slots/[slug]/PackDetailSections';
import { blockOf, topHitsOf } from './focus-stops-data';
import { useFlowData } from './use-flow-data';
import type { FlowData, FlowSeed } from './types';
import styles from './focus.module.css';

/** The focused pack's stops, in order. */
export type FocusStopKind =
  | 'front'
  | 'tophits'
  | 'odds'
  | 'buyback'
  | 'pulls'
  | 'closing';

export type FocusStopsProps = {
  seed: FlowSeed;
  /** This pack's stops (stop k >= 1 is kinds[k - 1]). */
  kinds: readonly FocusStopKind[];
  /**
   * `stage`: the blocks sit over the pinned panel and switch with the focus
   * value. `document`: every block in page order (reduced motion, no stage).
   */
  mode: 'stage' | 'document';
  /** Stage: the focus value, as it changes; returns its unsubscribe. */
  subscribe?: (fn: (focus: number) => void) => () => void;
  /** Stage: page to stop k (the icons). */
  go?: (k: number) => void;
  /** "All packs". */
  leave: () => void;
  /** The live back to print (changes with the 60 s poll). */
  onBack?: (back: PackBackDetails | null) => void;
  /** The active block fades before the return to the row. */
  leaving?: boolean;
  /** Phone (under 1024 px): the dock holds the buy controls. */
  desktop: boolean;
  /** Open hands the reel address here instead of navigating (usePackBuy). */
  onGoToReel?: (href: string) => void;
};

const TITLES: Record<FocusStopKind, string> = {
  front: 'Pack',
  tophits: 'Top Hits',
  odds: 'Pull odds by rarity',
  buyback: 'Buyback',
  pulls: 'Recent pulls',
  closing: 'Open',
};

const ICONS: {
  kind: FocusStopKind;
  label: string;
  Icon: typeof Gem;
}[] = [
  { kind: 'tophits', label: 'Top Hits', Icon: Gem },
  { kind: 'odds', label: 'Pull odds', Icon: Percent },
  { kind: 'buyback', label: 'Buyback', Icon: Coins },
  { kind: 'pulls', label: 'Recent pulls', Icon: History },
];

/** The phone's compact odds board: one row per tier with a chance (fits one panel). */
function CompactOdds({
  tiers,
  tickets,
}: {
  tiers: FlowData['tiers'];
  tickets: boolean;
}) {
  if (!tiers) return <div className={styles.wait} aria-hidden />;
  const rows = tiers.tiers.filter((t) => t.chance != null);
  const noun = tickets ? 'prize' : 'card';
  return (
    <ol className={styles.compact}>
      {rows.map((t) => (
        <li key={t.rarity}>
          <span
            aria-hidden
            className={styles.dot}
            style={{ backgroundColor: `rgb(${rarityRgb(t.rarity)})` }}
          />
          <span className={styles.tier}>{t.rarity}</span>
          <span className={styles.count}>
            {t.count} {t.count === 1 ? noun : `${noun}s`}
          </span>
          <span className={styles.chance}>{t.chance}%</span>
        </li>
      ))}
    </ol>
  );
}

/** What usePackBuy reads from a detail: only whether the pool has a card. */
function demoDetail(data: FlowData): PackDetail | null {
  const pool = (data.tiers?.tiers ?? []).flatMap((t) => t.cards ?? []);
  const detail = { topHits: [], pool } as unknown as PackDetail;
  return pool.length > 0 ? detail : null;
}

/**
 * The focused pack's stops: Front, Top
 * Hits, Pull Odds, Buyback, Recent Pulls, Closing (a capsule has no Buyback,
 * a pack with no pull odds neither Pull Odds nor Buyback). Over the stage one
 * block shows at a time, switched 20% into a move on 0.5 s fades; an icon
 * column pages straight to a stop and a progress line follows the stops.
 */
export function FocusStops({
  seed,
  kinds,
  mode,
  subscribe,
  go,
  leave,
  onBack,
  leaving = false,
  desktop,
  onGoToReel,
}: FocusStopsProps) {
  const stage = mode === 'stage';
  // On the stage the live data (tier view, recent pulls) is fetched and drawn
  // only once the pack has first settled at a stop: its render, layout and
  // pictures must never land inside the tap's zoom. Then it re-renders the
  // blocks at low priority (sliced).
  const [armed, setArmed] = useState(!stage);
  const data = useDeferredValue(useFlowData(seed, { enabled: armed }));
  const { pack } = data;
  const tickets = isTicketPack(pack);
  const noun = tickets ? 'capsule' : 'pack';
  const buy = usePackBuy(pack, demoDetail(data), { onGoToReel });
  const overlay = usePackCardOverlay(pack.id);
  const facts = packFacts(pack);
  const n = kinds.length;

  // the live back goes to the 3D print (a reprint when its text changes)
  const backRef = useRef(onBack);
  useEffect(() => {
    backRef.current = onBack;
  });
  const { back, backKey } = data;
  useEffect(() => {
    backRef.current?.(back);
    // backKey changes exactly when the printed text does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backKey]);

  // the block and the progress follow the focus value (state only on change)
  const [block, setBlock] = useState(stage ? 0 : -1);
  const progressRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stage || !subscribe) return;
    let last = 0;
    return subscribe((f) => {
      setBlock(blockOf(f, n, f < last));
      last = f;
      if (f >= 1 - 1e-3 && Math.abs(f - Math.round(f)) < 1e-3) setArmed(true);
      const p = n > 1 ? Math.min(1, Math.max(0, (f - 1) / (n - 1))) : 1;
      progressRef.current?.style.setProperty('--p', String(f < 1 ? 0 : p));
    });
  }, [stage, subscribe, n]);

  // after each move, keyboard focus and the live region follow the new block
  const headings = useRef<(HTMLElement | null)[]>([]);
  const sayKind = stage && block >= 1 ? kinds[block - 1] : undefined;
  const said = sayKind
    ? sayKind === 'front'
      ? pack.name
      : TITLES[sayKind]
    : '';
  useEffect(() => {
    if (!stage || block < 1) return;
    headings.current[block - 1]?.focus({ preventScroll: true });
  }, [stage, block]);

  const rail = useMemo(() => topHitsOf(data, tickets), [data, tickets]);
  const pool = useMemo(
    () =>
      (data.tiers?.tiers ?? []).flatMap(
        (t) => t.cards ?? [],
      ) as unknown as PackCard[],
    [data.tiers],
  );
  const chase = rail[0] ?? null;
  const price = buy.vaultCost ?? rm(buy.priceNum * buy.qty);

  const head = (k: number, children: ReactNode, cls = '') => (
    <h2
      ref={(el) => {
        headings.current[k] = el;
      }}
      tabIndex={-1}
      className={`${styles.title} ${cls}`}
    >
      {children}
    </h2>
  );

  const allPacks = (cls = '') => (
    <button type="button" onClick={leave} className={`${styles.back} ${cls}`}>
      <ArrowLeft className="h-4 w-4" aria-hidden />
      <span className={styles.backLabel}>All {noun}s</span>
    </button>
  );

  const blockFor = (kind: FocusStopKind, k: number): ReactNode => {
    switch (kind) {
      case 'front':
        return (
          <>
            {!stage && allPacks()}
            <p className={styles.tag}>
              {facts.map((f) => f.value).join(' · ')}
            </p>
            {head(
              k,
              <span className={styles.line}>{pack.name}</span>,
              styles.name,
            )}
            {chase && (
              <p className={styles.lead}>
                Top hit: {chase.name}
                {chase.priceMyr != null && ` · ${rm(chase.priceMyr)}`}
              </p>
            )}
            {desktop ? (
              <div className={styles.buy}>
                <PackBuyControls model={buy} variant="panel" />
              </div>
            ) : (
              buy.showDemo && (
                <a href={buy.demoHref} className={styles.demo}>
                  Try a free demo spin
                </a>
              )
            )}
          </>
        );
      case 'tophits':
        return (
          <>
            <p className={styles.tag}>
              {rail.length > 0
                ? `${rail.length} ${tickets ? 'prizes' : 'cards'}`
                : tickets
                  ? 'All prizes'
                  : 'All cards'}
            </p>
            {head(k, <span className={styles.line}>Top Hits</span>)}
            <p className={styles.lead}>
              {tickets
                ? 'The biggest ticket prizes in this capsule.'
                : 'The top-tier cards available in this pack.'}
            </p>
            <div className={styles.strip}>
              {data.tiers ? (
                <PoolByRarity
                  key={pack.id}
                  rail={rail.length > 0 ? rail : pool}
                  full={pool}
                  tierChances={data.tiers ? pullOddsOf(data.tiers.tiers) : null}
                  onOpen={(card) => overlay.open(card)}
                  pokemon={isPokemonPack(pack.categoryId)}
                  header={false}
                />
              ) : (
                <div className={styles.wait} aria-hidden />
              )}
            </div>
          </>
        );
      case 'odds':
        return (
          <>
            {!tickets && <p className={styles.tag}>Printed on the back</p>}
            {head(k, <span className={styles.line}>Pull odds by rarity</span>)}
            <div className={styles.board}>
              {desktop || !stage ? (
                <PackPullOdds
                  pack={pack}
                  tiers={data.tiers}
                  counts
                  bare
                  heading={false}
                />
              ) : (
                <CompactOdds tiers={data.tiers} tickets={tickets} />
              )}
            </div>
          </>
        );
      case 'buyback':
        return (
          <>
            <p className={styles.tag}>Printed on the back</p>
            {head(
              k,
              <span className={styles.line}>
                {data.back?.buyback?.headline ??
                  `${buy.buybackPercent}% instant buyback`}
              </span>,
            )}
            {data.back?.buyback?.rule && (
              <p className={styles.lead}>{data.back.buyback.rule}</p>
            )}
          </>
        );
      case 'pulls':
        return (
          <>
            {head(k, <span className={styles.line}>Recent Pulls</span>)}
            <div className={styles.pulls}>
              {armed ? (
                <PackRecentPulls
                  pack={pack}
                  initial={data.recentPulls}
                  onOpenCard={overlay.open}
                  limit={desktop ? 8 : 4}
                  unseeded={seed.recentPulls === null}
                  bare
                />
              ) : (
                <div className={styles.wait} aria-hidden />
              )}
            </div>
          </>
        );
      case 'closing':
        return (
          <>
            {head(
              k,
              <span className={styles.line}>
                Open {pack.name} · {rm(buy.priceNum)}
              </span>,
              styles.closingTitle,
            )}
            <div className={styles.closingRow}>
              {buy.soldOut ? (
                <Pill variant="secondary" size="lg" disabled>
                  {buy.unavailableLabel}
                </Pill>
              ) : (
                <Pill
                  variant="primary"
                  size="lg"
                  onClick={buy.handleGoToReel}
                  className="justify-between gap-4 pl-6 pr-2"
                >
                  {buy.signedIn ? buy.openLabel : 'Log in to open'}
                  <span className="flex items-center gap-2.5 font-heading text-base tabular-nums">
                    {price}
                    <ArrowDisc />
                  </span>
                </Pill>
              )}
              {allPacks(styles.backPill)}
            </div>
          </>
        );
    }
  };

  const activeKind = block >= 1 ? kinds[block - 1] : undefined;
  const iconsOn = stage && block >= 1 && activeKind !== 'closing' && !leaving;
  const icons = ICONS.filter((i) => kinds.includes(i.kind));

  return (
    <div
      className={stage ? styles.over : styles.doc}
      data-leaving={leaving ? '1' : undefined}
      data-testid="focus-stops"
    >
      {stage && (
        <div ref={progressRef} className={styles.progress} aria-hidden>
          <span />
        </div>
      )}
      {stage && (
        <div
          className={styles.backTop}
          data-on={
            block >= 1 && activeKind !== 'closing' && !leaving ? '1' : undefined
          }
        >
          {allPacks()}
        </div>
      )}
      {kinds.map((kind, i) => {
        const k = i + 1;
        const on = !stage || block === k;
        return (
          <section
            key={kind}
            id={stage ? undefined : `focus-${kind}`}
            className={styles.block}
            data-kind={kind}
            data-on={on ? '1' : undefined}
            aria-hidden={on ? undefined : true}
            style={{ '--k': k } as CSSProperties}
          >
            {blockFor(kind, i)}
          </section>
        );
      })}
      {icons.length > 0 && (
        <nav
          aria-label={`${pack.name} sections`}
          className={styles.icons}
          data-on={iconsOn || !stage ? '1' : undefined}
        >
          {icons.map(({ kind, label, Icon }) => {
            const k = kinds.indexOf(kind) + 1;
            const current = activeKind === kind;
            return stage ? (
              <button
                key={kind}
                type="button"
                aria-label={label}
                aria-current={current ? 'step' : undefined}
                className={styles.icon}
                onClick={() => go?.(k)}
              >
                <Icon className="h-4 w-4" strokeWidth={1.5} aria-hidden />
              </button>
            ) : (
              <a
                key={kind}
                href={`#focus-${kind}`}
                aria-label={label}
                className={styles.icon}
              >
                <Icon className="h-4 w-4" strokeWidth={1.5} aria-hidden />
              </a>
            );
          })}
        </nav>
      )}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {said}
      </p>
      {!desktop && (!stage || activeKind === 'front') && (
        // the overlay layer lets taps through; the dock takes them
        <div className={styles.live}>
          <PackBuyControls model={buy} variant="dock" />
        </div>
      )}
      {/* on the page body: over the header and the tab bar, and outside the
          click-through layer (its scrim, Close and scrolling take input) */}
      {typeof document !== 'undefined' &&
        createPortal(
          <PackCardOverlay pack={pack} overlay={overlay} />,
          document.body,
        )}
    </div>
  );
}
