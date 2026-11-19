'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { Layers, ShieldCheck, RectangleVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm0 } from '@/lib/format';
import { isOptimizableImage } from '@/lib/optimizable-image';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';
import { BENTO_COL, bentoLayout } from '@/lib/catalog-bento';
import { IntentLink } from '@/components/IntentLink';
import { pillVariants } from '@/components/ui/pill';
import { chipVariants } from '@/components/ui/chip';
import {
  ArrowDisc,
  Bezel,
  EYEBROW,
  SOFT_H2,
  SPRING,
} from '@/components/ui/soft';
import Reveal from '@/components/Reveal';
import QtyStepper from '@/components/QtyStepper';
import FreePackBadge from '@/components/FreePackBadge';
import PackCategoryTabs from '@/components/PackCategoryTabs';
import {
  groupPacks,
  packFacts,
  packHref,
  packTabs,
  pickCategory,
  shelfPacks,
  shelvePacks,
  CATALOG_GROUP_HEADING,
  PACK_LANGUAGE_LABEL,
  factoryVideo,
  PACK_TYPE_LABEL,
  isTicketPack,
  type CatalogGroup,
  type Pack,
  type PackCategory,
  type PackLanguage,
  type PackShelf,
} from '@/lib/packs-data';
import type { FreePackState } from '@/lib/data/free-pack';

// Pack catalog comes from the backend via getPackCategories() (server page);
// types + presentational category meta live in @/lib/packs-data.
//
// The look (2026-11-18) is the "soft" direction: every card is a nested
// double bezel (a tray with a plate in it, concentric corners), buttons carry
// their arrow in a nested disc, and anything that moves does so on one spring
// curve by transform and opacity alone. It is this page's own exception to
// DESIGN.md's 16px corner cap (recorded there). What the page SAYS is
// unchanged: the signal colours, the PSA 10 / Ungraded headings and the buyback
// sentence are the same claims as before.

type Entry = { pack: Pack; icon: string; categoryName: string };

/** The status a pack wears in the corner of its art: sold out, a Draft, or a
 *  boosted buyback rate. One at a time, in that order. */
function StatusBadge({ pack }: { pack: Pack }) {
  const base =
    'rounded-full px-2.5 py-1 text-xs font-bold uppercase leading-none tracking-wide';
  if (pack.inStock === false)
    return (
      <span className={cn(base, 'bg-neutral-700 text-neutral-200')}>
        Out of Stock
      </span>
    );
  if (pack.draft)
    return <span className={cn(base, 'bg-white/15 text-white')}>Draft</span>;
  if (pack.boost)
    return (
      <span className={cn(base, 'bg-buyback text-white')}>
        {pack.buybackPercent ?? 90}% Instant Buyback
      </span>
    );
  return null;
}

// ---------------------------------------------------------------------------
// Pack card (md and up) — one component for every bento cell. It reads its own
// width: narrow cells stack the art over the details, wide ones (the lead, a
// last row shared by one or two packs) lay them side by side. The lead also
// states the pack's facts, the same ones the pack page's header does.
// Out-of-stock packs render greyed + "Sold out" and link nowhere. Open goes to
// the pack's page with the stepper's count (the free demo spin there needs no
// login — only a real open/claim is auth-gated).
// ---------------------------------------------------------------------------

function PackCard({
  entry,
  lead,
  withScene,
}: {
  entry: Entry;
  lead: boolean;
  /** The lead has the height for its factory scene: two rows tall, or alone
   *  on its row. Beside one or two other packs it would tower over them. */
  withScene: boolean;
}) {
  const { pack, icon, categoryName } = entry;
  const [qty, setQty] = useState(1);
  const oos = pack.inStock === false;
  const buyback = pack.buybackPercent ?? 90;
  const facts = lead
    ? packFacts({ ...pack, categoryId: '', categoryName, icon })
    : [];
  // The pack's own factory scene, as a still: the loop belongs to the pack
  // page (it starts on hydration, visible or not), and three of them here
  // would download for cards nobody scrolled to. None on a pack without one.
  const scene = withScene
    ? (factoryVideo(pack.displayImage)?.poster ?? pack.displayImage)
    : undefined;
  return (
    <Bezel
      className={cn(
        'group h-full @container',
        // Sold out dims the art, never the words: a whole card at 60% put
        // its own "Sold out" under 4.5:1.
        !oos && 'hover:bg-white/[0.07] hover:ring-white/20',
      )}
      core="flex h-full flex-col gap-4 p-4 @[26rem]:flex-row @[26rem]:gap-6 @[26rem]:p-6"
    >
      {/* Art, on a soft pool of neutral light: the pack is the only thing lit. */}
      <div className="relative flex shrink-0 items-center justify-center rounded-[1.25rem] bg-[radial-gradient(closest-side,rgba(255,255,255,0.1),transparent)] py-2 @[26rem]:w-2/5 @[26rem]:py-0">
        <span className="absolute left-0 top-0 z-[2]">
          <StatusBadge pack={pack} />
        </span>
        <Image
          src={icon}
          alt=""
          aria-hidden="true"
          width={24}
          height={24}
          className="absolute right-0 top-0 z-[2] h-6 w-6 object-contain opacity-80"
        />
        <Image
          src={pack.image}
          alt={pack.name}
          // Raw art runs to 2.4 MB; the lead is drawn up to ~195x352 CSS px,
          // the rest at 80x144.
          width={lead ? 300 : 137}
          height={lead ? 540 : 240}
          // Operator-entered pack art can be on any host — bypass the optimizer
          // allowlist only there (matches the detail hero), else the thumbnail 400s.
          unoptimized={!isOptimizableImage(pack.image)}
          className={cn(
            'w-auto object-contain transition-transform duration-700',
            SPRING,
            'motion-reduce:transition-none',
            lead ? 'h-44 @[26rem]:h-[22rem]' : 'h-36 @[26rem]:h-56',
            oos
              ? 'opacity-50 grayscale'
              : 'group-hover:-translate-y-1 group-hover:scale-[1.04] motion-reduce:group-hover:transform-none',
          )}
        />
      </div>

      {/* Wide enough (a lone pack across the whole row), the scene moves
          beside the details instead of under them. */}
      <div className="flex min-w-0 flex-1 flex-col @[56rem]:grid @[56rem]:grid-cols-[1fr_26rem] @[56rem]:grid-rows-[auto_1fr] @[56rem]:gap-x-8">
        <div className="flex min-w-0 flex-col">
          <p
            className={cn(
              'font-semibold text-white',
              lead
                ? 'text-base @[26rem]:font-heading @[26rem]:text-3xl @[26rem]:font-bold @[26rem]:leading-[1.05] @[26rem]:tracking-[-0.02em]'
                : 'truncate text-sm',
            )}
          >
            {pack.name}
          </p>
          {!isTicketPack(pack) && (
            <p className="mt-1 text-xs text-neutral-400">
              {categoryName} · {buyback}% instant buyback
            </p>
          )}
          <p
            className={cn(
              'mt-2 whitespace-nowrap font-heading tabular-nums text-white',
              lead ? 'text-xl @[26rem]:text-4xl' : 'text-xl',
            )}
          >
            {rm0(pack.priceMyr)}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {oos ? (
              <span className="flex h-11 w-full items-center justify-center rounded-full bg-white/[0.06] text-[13px] font-semibold text-neutral-400 ring-1 ring-white/10">
                Sold out
              </span>
            ) : (
              <>
                {/* Quantity stepper — − 1 + MAX. The reel opens 1–3 per spin. */}
                <QtyStepper qty={qty} onChange={setQty} max={3} />
                <IntentLink
                  href={packHref(pack.id, qty)}
                  className={cn(
                    pillVariants({ variant: 'primary', size: 'md' }),
                    // Fills a narrow card; on a wide one a button the width
                    // of the card stops reading as a button.
                    'group/open min-w-[7rem] flex-1 justify-between pl-5 pr-1.5 @[26rem]:max-w-[14rem]',
                  )}
                >
                  Open
                  <ArrowDisc className="group-hover/open:-translate-y-px group-hover/open:translate-x-0.5 group-hover/open:scale-105 motion-reduce:group-hover/open:transform-none" />
                </IntentLink>
              </>
            )}
          </div>
        </div>

        {scene && (
          <div className="relative mt-6 hidden aspect-[36/25] w-full max-w-md overflow-hidden rounded-[1.25rem] ring-1 ring-white/10 @[26rem]:block @[56rem]:col-start-2 @[56rem]:row-span-2 @[56rem]:row-start-1 @[56rem]:mt-0 @[56rem]:self-center">
            <Image
              src={scene}
              alt=""
              aria-hidden
              fill
              sizes="(min-width: 1024px) 28rem, 1px"
              // An uploaded scene may be an animated webp on any host.
              unoptimized={!isOptimizableImage(scene)}
              className="object-cover"
            />
          </div>
        )}

        {/* The lead has the room to say what kind of pack this is. */}
        {facts.length > 0 && (
          <dl className="mt-6 hidden grid-cols-2 gap-x-6 gap-y-4 self-end border-t border-white/10 pt-5 @[26rem]:mt-auto @[26rem]:grid @[26rem]:w-full @[56rem]:col-start-1 @[56rem]:row-start-2">
            {facts.map((fact) => (
              <div key={fact.label} className="flex flex-col gap-1">
                <dt className="text-xs font-semibold uppercase tracking-[0.02em] text-neutral-400">
                  {fact.label}
                </dt>
                <dd className="text-sm font-semibold text-white">
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Bezel>
  );
}

// ---------------------------------------------------------------------------
// Pack row (phones) — the single-column collapse of the bento: thumb | name +
// buyback line | price pill. The whole row is the tap target, opening one
// pack; the pack page's dock has the stepper. Out-of-stock rows render greyed
// + non-interactive with a "Sold out" pill.
// ---------------------------------------------------------------------------

function PackRow({ entry }: { entry: Entry }) {
  const { pack, icon, categoryName } = entry;
  const oos = pack.inStock === false;
  const buyback = pack.buybackPercent ?? 90;

  const inner = (
    <>
      {/* Thumbnail + category chip */}
      <div className="relative flex h-16 w-14 shrink-0 items-center justify-center rounded-2xl bg-[radial-gradient(closest-side,rgba(255,255,255,0.1),transparent)]">
        <Image
          src={pack.image}
          alt={pack.name}
          width={36}
          height={64}
          unoptimized={!isOptimizableImage(pack.image)}
          className={cn(
            'h-16 w-auto object-contain',
            oos && 'opacity-50 grayscale',
          )}
        />
        <Image
          src={icon}
          alt=""
          aria-hidden="true"
          width={16}
          height={16}
          className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full object-contain"
        />
      </div>

      {/* Name + buyback line */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-semibold text-white">
            {pack.name}
          </p>
          {pack.draft && (
            <span className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-xs font-bold uppercase leading-none tracking-wide text-white">
              Draft
            </span>
          )}
        </div>
        {oos ? (
          <span className="mt-1 block text-xs text-neutral-400">
            Out of stock
          </span>
        ) : pack.boost ? (
          <span className="mt-1 inline-block rounded-full bg-buyback px-2 py-0.5 text-xs font-bold uppercase leading-none tracking-wide text-white">
            {buyback}% Instant Buyback
          </span>
        ) : (
          <span className="mt-1 block text-xs text-neutral-400">
            {isTicketPack(pack)
              ? categoryName
              : `${categoryName} · ${buyback}% instant buyback`}
          </span>
        )}
      </div>

      {/* Price pill (tap target) / sold-out */}
      {oos ? (
        <span className="flex h-10 shrink-0 items-center rounded-full bg-white/[0.06] px-4 text-[13px] font-semibold text-neutral-400 ring-1 ring-white/10">
          Sold out
        </span>
      ) : (
        <span className="flex h-10 shrink-0 items-center gap-2 rounded-full bg-neutral-50 pl-4 pr-1 text-[13px] font-semibold text-neutral-950">
          {rm0(pack.priceMyr)}
          <ArrowDisc className="h-8 w-8 group-active:translate-x-0.5" />
        </span>
      )}
    </>
  );

  if (oos) {
    return (
      <Bezel size="md" core="flex items-center gap-3 p-2.5">
        {inner}
      </Bezel>
    );
  }

  return (
    <Bezel size="md">
      <IntentLink
        href={packHref(pack.id, 1)}
        className={cn(
          'group flex items-center gap-3 p-2.5 outline-none transition-transform duration-300',
          SPRING,
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40 active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100',
        )}
      >
        {inner}
      </IntentLink>
    </Bezel>
  );
}

// ---------------------------------------------------------------------------
// One shelf — a pack type (Classic / Original / Special, or the untagged rest),
// shelved and priced by the SAME `shelvePacks` the pack page's picker uses, so
// the two pages cannot disagree on where a pack sits or what comes first.
// Inside it the composition groups keep their own headings, auto-detected from
// the backend's §2.4.8 `group` + strict `psa10` gate (see catalogGroupOf):
// "Graded (Guaranteed PSA 10)" lists ONLY pools where every card is a PSA 10;
// "Raw Cards (Ungraded)" lists ONLY backend-derived all-raw pools; everything
// uncertain lists under the claim-free "More Packs" so neither heading can
// ever overclaim. A shelf that holds two languages shows one at a time.
// ---------------------------------------------------------------------------

// Headings + order come from packs-data (shared with the pack detail page's
// picker); only the icon and the qualifying note are this page's.
const GROUP_CHROME: Record<
  CatalogGroup,
  { note?: string; Icon: typeof ShieldCheck }
> = {
  graded: { note: 'Guaranteed PSA 10', Icon: ShieldCheck },
  raw: { note: 'Ungraded', Icon: RectangleVertical },
  // Claim-free by design — see catalogGroupOf's doc comment. No `note`:
  // an empty/omitted note is the only wording that's honest for every
  // member (MIX, non-PSA-10 graded, AND unknown/null composition alike).
  more: { Icon: Layers },
};

function Shelf({
  shelf,
  tagged,
  allCapsules,
  icon,
  categoryName,
}: {
  shelf: PackShelf;
  /** The franchise has pack types, so each shelf names its own. */
  tagged: boolean;
  allCapsules: boolean;
  icon: string;
  categoryName: string;
}) {
  const [picked, setPicked] = useState<PackLanguage | null>(null);
  // A language switch only where the shelf holds two; it always has a pick.
  const language =
    shelf.languages.length > 1
      ? picked && shelf.languages.includes(picked)
        ? picked
        : (shelf.languages[0] ?? null)
      : null;
  const shown = shelfPacks(shelf, language);
  const groups = groupPacks(shown);
  // The shelf's language, when every pack on show shares one. It goes in the
  // eyebrow, because a phone has no lead card to list a pack's facts on.
  const spoken =
    shown[0]?.language && shown.every((p) => p.language === shown[0]?.language)
      ? shown[0].language
      : null;
  const typeLabel = shelf.type ? PACK_TYPE_LABEL[shelf.type] : 'Other';
  const noun = allCapsules ? 'capsule' : 'pack';

  return (
    <>
      {groups.map((g, at) => {
        const chrome = GROUP_CHROME[g.id];
        const cells = bentoLayout(g.packs.length);
        const entries = g.packs.map((pack) => ({ pack, icon, categoryName }));
        return (
          <section key={g.id} className="mt-12 md:mt-24">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 md:mb-8">
              <div>
                {tagged && (
                  <span className={EYEBROW}>
                    {typeLabel}
                    {spoken && (
                      <>
                        <span aria-hidden className="text-neutral-500">
                          ·
                        </span>
                        {PACK_LANGUAGE_LABEL[spoken]}
                      </>
                    )}
                  </span>
                )}
                <h2
                  className={cn(
                    SOFT_H2,
                    'flex flex-wrap items-center gap-x-3 gap-y-1',
                    tagged && 'mt-3',
                  )}
                >
                  <chrome.Icon
                    className="h-7 w-7 shrink-0 text-neutral-300 md:h-8 md:w-8"
                    strokeWidth={1.25}
                    aria-hidden
                  />
                  {allCapsules && g.id === 'more'
                    ? 'More Capsules'
                    : CATALOG_GROUP_HEADING[g.id]}
                  {/* The parenthetical is body voice, not Nekst display. Skipped
                      entirely (not rendered empty) when a section has no note
                      that's honest for every pack in it — see GROUP_CHROME. */}
                  {chrome.note && (
                    <span className="font-sans text-sm font-medium tracking-normal text-neutral-400 md:text-base">
                      ({chrome.note})
                    </span>
                  )}
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                {/* Once per shelf, over its first group. */}
                {language && at === 0 && (
                  <div
                    role="group"
                    aria-label={`${typeLabel} pack language`}
                    className="flex gap-2"
                  >
                    {shelf.languages.map((l) => (
                      <button
                        key={l}
                        type="button"
                        aria-pressed={l === language}
                        onClick={() => setPicked(l)}
                        className={chipVariants(l === language)}
                      >
                        {PACK_LANGUAGE_LABEL[l]}
                      </button>
                    ))}
                  </div>
                )}
                <span className="text-[13px] text-neutral-400">
                  <span className="tabular-nums">{g.packs.length}</span>{' '}
                  {g.packs.length === 1 ? noun : `${noun}s`}
                </span>
              </div>
            </div>

            {/* lg and up: the bento. The first pack in the shelf's order leads
                (see catalog-bento.ts) — an order, not a recommendation. A
                tablet is too narrow for it and shows the cards three across. */}
            <div className="hidden gap-4 md:grid md:grid-cols-3 lg:grid-cols-12">
              {entries.map((e, i) => {
                const cell = cells[i];
                return (
                  <Reveal
                    key={e.pack.id}
                    delay={Math.min(i, 6) * 60}
                    className={cn(
                      'h-full',
                      cell && BENTO_COL[cell.col],
                      cell?.tall && 'lg:row-span-2',
                    )}
                  >
                    <PackCard
                      entry={e}
                      lead={i === 0}
                      withScene={
                        i === 0 && (cell?.tall === true || entries.length === 1)
                      }
                    />
                  </Reveal>
                );
              })}
            </div>

            {/* Phones: the bento collapses to one column of rows. */}
            <div className="flex flex-col gap-3 md:hidden">
              {entries.map((e) => (
                <PackRow key={e.pack.id} entry={e} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Client — the page, top to bottom: the header (which franchise, the page's
// name, the buyback term, the franchise switch), then one bento per shelf.
// `?category=<key>` picks the franchise, so a deep link preselects a tab.
// ---------------------------------------------------------------------------

export default function CatalogClient({
  categories,
  freePack = null,
}: {
  /** Every franchise, empty ones included (they show as "Coming soon"). */
  categories: PackCategory[];
  /** Visible badge state, or null. `claim` only while this customer's one-time
   *  welcome claim is unspent; `signup` for logged-out visitors while an
   *  active free pack exists. The badge is the free pack's only entry point
   *  (it is not in `categories`). */
  freePack?: Exclude<FreePackState, { mode: 'hidden' }> | null;
}) {
  // The URL is the only state: Back to a cached /slots, a shared link and a
  // refresh that drops a franchise all read the same ?category=.
  const active =
    pickCategory(categories, useSearchParams().get('category') ?? undefined) ??
    '';
  const tabs = packTabs(categories);
  const pick = (id: string) => {
    // Next syncs useSearchParams with replaceState; other params survive.
    const params = new URLSearchParams(window.location.search);
    params.set('category', id);
    window.history.replaceState(null, '', `?${params}`);
  };

  // One franchise at a time, shelved by pack type.
  const category = categories.find((c) => c.id === active);
  const packs = useMemo(() => category?.packs ?? [], [category]);
  const shelves = useMemo(() => shelvePacks(packs), [packs]);
  // A tab of only capsules (Poly): no buyback note, and they aren't called packs.
  const allCapsules = packs.every((p) => isTicketPack(p));
  const noun = allCapsules ? 'capsule' : 'pack';
  // Pack types are worth naming once the franchise has any.
  const tagged = shelves.some((s) => s.type !== null);

  return (
    <div
      data-testid="catalog-root"
      className={cn(
        'relative isolate mx-auto w-full px-fluid pb-16 pt-6 md:pb-24 md:pt-10',
        // The badge is `fixed` on the bottom-right rail, floating OVER the
        // catalog — at the end of the scroll it lands on the last row and
        // covers the right-most tile's MAX/Open controls. Reserve its rail as
        // bottom padding (only while the badge actually renders) so the
        // catalog can always be scrolled clear of it. Badge box: 146px tall
        // (112px art at 393x512) over a 4.5rem dock offset = 218px, dropping
        // to 24px + 146px = 170px once the tab bar is gone at lg.
        freePack && 'pb-56 md:pb-56 lg:pb-44',
      )}
    >
      {/* Two soft pools of neutral light behind the header. Neutral on purpose:
          a coloured glow here would be a colour that means nothing. It never
          scrolls a blur: plain gradients, no filter. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[36rem] bg-[radial-gradient(50%_60%_at_12%_0%,rgba(255,255,255,0.08),transparent_70%),radial-gradient(40%_50%_at_88%_8%,rgba(255,255,255,0.05),transparent_70%)]"
      />

      {freePack && <FreePackBadge state={freePack} />}

      <Reveal
        as="header"
        className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-10"
      >
        <div className="min-w-0 max-w-2xl">
          {category && (
            <span className={EYEBROW}>
              <Image
                src={category.icon}
                alt=""
                aria-hidden
                width={16}
                height={16}
                className="h-4 w-4 object-contain"
              />
              {category.tab}
              <span aria-hidden className="text-neutral-500">
                ·
              </span>
              <span>
                <span className="tabular-nums">{packs.length}</span>{' '}
                {packs.length === 1 ? noun : `${noun}s`}
              </span>
            </span>
          )}
          <h1 className="mt-4 font-heading text-[clamp(2.5rem,7vw,5.5rem)] font-bold leading-[0.95] tracking-[-0.03em] text-white">
            Pick a {noun}
          </h1>
          {!allCapsules && (
            <p className="mt-4 max-w-xl text-[13px] leading-relaxed text-neutral-400 md:text-sm">
              Instant buyback rates apply during the reveal countdown. Leaving
              the reveal or letting its timer expire changes buyback to{' '}
              {BUYBACK_RATE_LABEL} of card value in your vault.
            </p>
          )}
        </div>

        {/* Franchise switch — only once there are two to pick from. Not sticky:
            the app header is sticky itself and would cover it. The switch is
            the plate; this is its tray. */}
        {tabs.length > 1 && (
          <div className="w-full shrink-0 rounded-full bg-white/[0.04] p-1.5 ring-1 ring-white/10 md:w-[26rem]">
            <PackCategoryTabs
              categories={tabs}
              active={active}
              onChange={pick}
              compact
            />
          </div>
        )}
      </Reveal>

      {/* Empty state — zero packs in the catalog (the backend is the source
          of truth). */}
      {packs.length === 0 && (
        <Bezel className="mt-12" core="px-6 py-14 text-center">
          <p className="text-sm text-neutral-400">
            No packs available right now — check back soon.
          </p>
        </Bezel>
      )}

      {category &&
        shelves.map((shelf) => (
          <Shelf
            // A switched franchise is a new set of shelves: its language pick
            // must not carry over.
            key={`${category.id}:${shelf.type ?? 'other'}`}
            shelf={shelf}
            tagged={tagged}
            allCapsules={allCapsules}
            icon={category.icon}
            categoryName={category.tab}
          />
        ))}
    </div>
  );
}
