import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Container,
  Heading,
  Text,
  Input,
  Label,
  Button,
  IconButton,
  Checkbox,
  Select,
  StatusBadge,
  Switch,
  Table,
  toast,
} from '@medusajs/ui';
import { XMark } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  getPriceChartingCollection,
  getPriceChartingProduct,
  getTcgCardMeta,
  type PcOffer,
} from '../../../lib/admin-rest';
import {
  useFxRate,
  useCreateProductsFromPriceChartingBatch,
  type PcQueueItem,
} from '../../../lib/queries';
import { resolveImageUrl } from '../../../lib/image-url';
import { useTableSort } from '../../../lib/use-table-sort';
import {
  rm,
  usdToMyr,
  gradeToGrader,
  graderFromInclude,
} from '../../../lib/format';
import CardPokemonFields, {
  type CardPokemonValue,
} from '../../cards/CardPokemonFields';
import { GachaPipelineHint } from '../../../components/GachaPipelineHint';
import { GraderGradeSelect } from '../../../components/GraderGradeSelect';

export const config: RouteConfig = {
  label: 'Add from PC Collection',
  nested: '/inventory',
  rank: 3,
};

// Bulk sibling of /products/from-pricecharting: instead of searching PriceCharting
// one card at a time, scan the operator's own PriceCharting collection and onboard
// many holdings in one pass. Everything downstream is shared — the same per-grade
// price lookup, the same single-item creation endpoint, the same batch runner —
// so an imported product is indistinguishable from a hand-searched one.
//
// An offer's own `value_usd` is NEVER written as market_value: it is
// PriceCharting's valuation of that offer, and the nightly sync would overwrite
// it with the grade price on its first run. Import re-reads the per-grade FMV.

// ponytail: per-failure error toasts are capped so a big import cannot bury the
// screen; the summary names how many were hidden. Same cap as the search page.
const ERROR_TOAST_CAP = 5;

// @medusajs/ui's Select rejects '' as an item value (see GraderGradeSelect), so
// "no tier picked yet" travels as a sentinel through the select only.
const NO_TIER = '__none__';

// Hard stop on the scan loop. The measured collection is ~9,000 offers at 30 per
// request; this covers it with headroom and still bounds a runaway cursor.
const MAX_SCAN_PAGES = 500;

// Rows rendered at once. The scan can hold five figures of offers, and every row
// carries a thumbnail — rendering them all would fire thousands of image
// requests for rows nobody can see. Anything past this is reached by filtering.
const MAX_VISIBLE_ROWS = 300;

// Server backstop (api/admin/products/from-pricecharting/route.ts). Enforced
// here too so a typo fails the field, not the whole batch at save time.
const MAX_STOCK = 10_000;

/** Identity of ONE holding. The API guarantees a per-row offer id (rows without
 *  one are dropped there), so this never falls back to product+tag — which is
 *  productKey, and would make two distinct holdings look like one. */
const offerKey = (o: PcOffer): string => o.offer_id;

/** PriceCharting's tag is free text, so compare it case- and spacing-blind. */
const normalizedInclude = (include: string): string =>
  include.trim().toLowerCase().replace(/\s+/g, ' ');

/** Two holdings of the SAME product at the SAME grade tier become ONE product:
 *  the created handle is name-grader-grade-pc_product_id, so importing them
 *  separately would collide (the second create fails) and the units held would
 *  be undercounted. Grouped on import, with stock summed instead. */
const productKey = (o: PcOffer): string =>
  `${o.product_id}|${normalizedInclude(o.include)}`;

/** Graded in PriceCharting's sense: anything it did not tag "Ungraded". The
 *  slab tier is what a gacha storefront onboards, so the table defaults to it. */
const isGraded = (o: PcOffer): boolean => !/^\s*ungraded\s*$/i.test(o.include);

/** One imported holding, pending the facts PriceCharting cannot supply: the
 *  pixel Pokémon (required by the backend) and the units actually held. */
type Draft = {
  key: string;
  productId: string;
  name: string;
  set: string;
  /** Per-grade values from /admin/pricecharting/product — the tier options. */
  prices: { grade: string; usd: number }[];
  /** Chosen tier; '' when the offer's PriceCharting tag named no priced field. */
  pcGrade: string;
  /** The offer's PriceCharting grade tag, verbatim — the operator's own record
   *  of what the physical slab is, which the price tier alone can't carry
   *  (every 9 prices off the same generic "Grade 9" field). */
  include: string;
  /** Grader + grade the operator asserts for THIS slab. Seeded from the offer's
   *  tag when it names a grading company, blank otherwise — PriceCharting drops
   *  the company below its top-tier fields ("Graded 9"), and §3a forbids
   *  inventing one, so the operator states it. This single value is both what
   *  the row displays and what is submitted. */
  grader: string;
  grade: string;
  image: string;
  stock: string;
  /** How many collection holdings collapsed into this draft (see productKey).
   *  Shown beside the row so the operator knows what to type into Units — the
   *  field itself imports as 0 (nothing is listed for sale until they say so). */
  merged: number;
  /** Slab-label text (§8), prefilled from pokemontcg.io like the search page. */
  labelYear: string;
  labelNote: string;
  pokemon: CardPokemonValue;
};

const draftUsd = (d: Draft): number | null =>
  d.prices.find((p) => p.grade === d.pcGrade)?.usd ?? null;

const stockValid = (raw: string): boolean =>
  raw.trim() !== '' &&
  Number.isInteger(Number(raw)) &&
  Number(raw) >= 0 &&
  Number(raw) <= MAX_STOCK;

/** A draft is savable only once it carries every field the creation endpoint
 *  requires; returns null while it doesn't. */
const toItem = (d: Draft): PcQueueItem | null => {
  const usd = draftUsd(d);
  if (usd === null) return null;
  if (d.pokemon.pixel_pokemon_id === null) return null;
  // name is required server-side; upstream can return a blank product name.
  if (d.name.trim() === '') return null;
  if (d.image.trim() === '' || !stockValid(d.stock)) return null;
  // Whatever the operator has on screen, verbatim — no second derivation. A
  // grade without a grader is unrepresentable (§3a), so it travels blank.
  return {
    pc_product_id: d.productId,
    pc_grade: d.pcGrade,
    name: d.name,
    set: d.set,
    grader: d.grader,
    grade: d.grader === '' ? '' : d.grade,
    market_value: usd,
    image: d.image,
    stock: Number(d.stock),
    pixel_pokemon_id: d.pokemon.pixel_pokemon_id,
    label_year: d.labelYear.trim() || null,
    label_note: d.labelNote.trim() || null,
  };
};

const AddFromPcCollectionPage = () => {
  const { t } = useTranslation();
  const { data: fx } = useFxRate();
  const batchCreate = useCreateProductsFromPriceChartingBatch();
  const draftSeq = useRef(0);

  // Step 1 — scan the collection, page by page. It runs to five figures, so the
  // operator watches counters climb and stops as soon as the rows they came for
  // are on screen rather than waiting out the whole walk.
  const [offers, setOffers] = useState<PcOffer[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scannedPages, setScannedPages] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  // A failed scan must not render as "your collection is empty" — the most
  // likely first-run failure is a missing PRICECHARTING_SELLER_ID, whose 503
  // explains exactly what to do.
  const [scanError, setScanError] = useState<string | null>(null);
  const stopScanRef = useRef(false);
  const cursorRef = useRef('');
  const foreignRef = useRef(0);

  // Step 2 — narrow. A real collection mixes cards with games and hardware, and
  // is overwhelmingly ungraded, so both filters default ON.
  const [cardsOnly, setCardsOnly] = useState(true);
  const [gradedOnly, setGradedOnly] = useState(true);
  const [filter, setFilter] = useState('');
  // Client-side sort over the WHOLE match set (see the pre-slice note in
  // `matches`). Null = scan order. Selection is keyed by offer_id and survives
  // reordering by design, same as it survives filter changes.
  const { sort, sortHeader } = useTableSort<
    'item' | 'pcTag' | 'tier' | 'offerValue'
  >(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  // Step 3 — import (one per-grade price lookup per picked product, sequential:
  // PriceCharting's API is rate-limited and each call also scrapes the photo).
  const [importing, setImporting] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const stopImportRef = useRef(false);

  // Step 4 — the drafts, finished by hand and saved as one batch.
  const [drafts, setDrafts] = useState<Draft[]>([]);

  const saving = batchCreate.isPending;
  const fxEffective = fx?.effective ?? null;

  const usdLabel = (usd: number | null): string =>
    usd === null
      ? '—'
      : fxEffective !== null
        ? rm(usdToMyr(usd, fxEffective))
        : `$${usd.toFixed(2)}`;

  const scan = async (restart: boolean) => {
    if (scanning) return;
    stopScanRef.current = false;
    setScanning(true);
    setScanError(null);
    if (restart) {
      cursorRef.current = '';
      foreignRef.current = 0;
      setOffers([]);
      setScannedPages(0);
      setExhausted(false);
      setSelected({});
    }
    try {
      for (let page = 0; page < MAX_SCAN_PAGES; page++) {
        if (stopScanRef.current) break;
        const data = await getPriceChartingCollection(cursorRef.current);
        // Upstream said these rows belong to somebody else — the seller id is
        // set but is not the account the token reads. Importing them would put
        // other people's cards in our catalog, so the API already dropped them;
        // say so instead of quietly serving a short page.
        if (data.foreign_dropped > 0) foreignRef.current += data.foreign_dropped;
        setOffers((prev) => {
          const rows = prev ?? [];
          const seen = new Set(rows.map(offerKey));
          // Dedupe on append: a cursor replay would otherwise double rows and
          // let the same holding be imported twice.
          return [
            ...rows,
            ...data.offers.filter((o) => !seen.has(offerKey(o))),
          ];
        });
        setScannedPages((n) => n + 1);
        cursorRef.current = data.cursor;
        if (!data.cursor) {
          setExhausted(true);
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setScanError(message);
      toast.error(message);
    } finally {
      setScanning(false);
      if (foreignRef.current > 0) {
        toast.warning(
          t('pcCollection.foreignDropped', { n: foreignRef.current }),
        );
        foreignRef.current = 0;
      }
    }
  };

  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = (offers ?? []).filter((o) => {
      if (cardsOnly && !o.is_card) return false;
      if (gradedOnly && !isGraded(o)) return false;
      if (q === '') return true;
      // Grade tag + condition are searchable too: inside a five-figure
      // collection "psa 10" is as natural a query as a card name.
      return (
        o.name.toLowerCase().includes(q) ||
        o.set.toLowerCase().includes(q) ||
        o.include.toLowerCase().includes(q) ||
        o.condition.toLowerCase().includes(q)
      );
    });
    // Sorted HERE, before the MAX_VISIBLE_ROWS slice below — sorting only the
    // visible 300 would reorder an arbitrary prefix of a five-figure list.
    if (!sort) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (o: PcOffer): number | string => {
      switch (sort.key) {
        case 'item':
          return o.name;
        case 'pcTag':
          return o.include || o.condition;
        case 'tier':
          return o.grade ?? '';
        case 'offerValue':
          return o.value_usd ?? Number.NEGATIVE_INFINITY;
      }
    };
    return [...filtered].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === 'string' && typeof bv === 'string') {
        return dir * av.localeCompare(bv);
      }
      return dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });
  }, [offers, filter, cardsOnly, gradedOnly, sort]);

  const visible = matches.slice(0, MAX_VISIBLE_ROWS);

  // Picks survive a filter change: selecting a row and then narrowing the
  // filter must not silently drop it from the import.
  const picked = (offers ?? []).filter((o) => selected[offerKey(o)]);
  const allVisibleSelected =
    visible.length > 0 && visible.every((o) => selected[offerKey(o)]);

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = { ...prev };
      for (const o of visible) {
        if (allVisibleSelected) delete next[offerKey(o)];
        else next[offerKey(o)] = true;
      }
      return next;
    });
  };

  const importSelected = async () => {
    if (picked.length === 0 || importing) return;
    stopImportRef.current = false;

    // Collapse holdings that would mint the same product (same PriceCharting
    // product at the same grade tag) into one draft carrying their unit count.
    const groups = new Map<string, PcOffer[]>();
    for (const o of picked) {
      const k = productKey(o);
      groups.set(k, [...(groups.get(k) ?? []), o]);
    }
    const work = [...groups.values()];

    setImporting({ done: 0, total: work.length });
    let imported = 0;
    const skipped: string[] = [];
    const done: PcOffer[] = [];

    for (const [i, group] of work.entries()) {
      if (stopImportRef.current) break;
      const offer = group[0];
      try {
        const product = await getPriceChartingProduct(offer.product_id);
        // The offer carries its own photo on PriceCharting's bucket, so it can
        // stand in when the product-page scrape comes back empty — the backend
        // ingests either through the same media pipeline.
        const image = product.image ?? offer.image ?? '';
        const name = product.name || offer.name;
        if (image === '') {
          skipped.push(t('pcCollection.skip.noImage', { name }));
        } else if (product.prices.length === 0) {
          skipped.push(t('pcCollection.skip.noPrices', { name }));
        } else {
          // Keep the mapped tier only if PriceCharting actually prices it for
          // this product; otherwise leave it unset for the operator to pick.
          const mapped =
            offer.grade !== null &&
            product.prices.some((p) => p.grade === offer.grade)
              ? offer.grade
              : '';
          const key = String(++draftSeq.current);
          // Seed from the offer's tag when it names a grader ("PSA 10"), else
          // from the picked tier when THAT names one; a generic tier leaves it
          // blank for the operator to state.
          const asserted = graderFromInclude(offer.include);
          const seeded =
            asserted.grader !== '' ? asserted : gradeToGrader(mapped);
          const row: Draft = {
            key,
            productId: offer.product_id,
            name,
            set: product.set || offer.set,
            prices: product.prices,
            pcGrade: mapped,
            include: offer.include,
            grader: seeded.grader,
            grade: seeded.grader === '' ? '' : seeded.grade,
            image,
            // Units default to 0, same as the from-pricecharting search page.
            // A PriceCharting collection records what the operator OWNS, not
            // what is sellable here, so importing the holding count straight
            // into sellable stock published inventory nobody had decided to
            // list. The merged count is still shown beside the row, so the
            // operator can type it in deliberately.
            stock: '0',
            merged: group.length,
            labelYear: '',
            labelNote: '',
            pokemon: { pixel_pokemon_id: null },
          };
          // Land the draft in state NOW, not in a bulk append after the loop:
          // the label prefill below patches by key, and while later products
          // are still being priced that key would not exist yet — every
          // prefill but the last would silently no-op.
          setDrafts((all) => [...all, row]);
          imported += 1;
          // §7a label prefill, same as the search page: year (set release) +
          // note (rarity) from pokemontcg.io. Fire-and-forget and fill-only —
          // it lands on THIS draft by key, and a lookup failure just leaves the
          // fields blank for the operator.
          const num = name.match(/#\s*([A-Za-z0-9/-]+)\s*$/)?.[1] ?? '';
          void getTcgCardMeta(product.set || offer.set, num)
            .then((meta) => {
              setDrafts((all) =>
                all.map((r) =>
                  r.key === key
                    ? {
                        ...r,
                        labelYear: r.labelYear || meta.year || '',
                        labelNote: r.labelNote || meta.note || '',
                      }
                    : r,
                ),
              );
            })
            .catch(() => {});
          done.push(...group);
        }
      } catch (err) {
        skipped.push(
          `${offer.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      setImporting({ done: i + 1, total: work.length });
    }

    // Drafts were already committed one by one above (see the prefill note).
    // Only the offers that actually became drafts leave the selection, so a
    // stopped or failed import can be retried without re-picking.
    setSelected((prev) => {
      const next = { ...prev };
      for (const o of done) delete next[offerKey(o)];
      return next;
    });
    setImporting(null);

    if (imported > 0) {
      toast.success(t('pcCollection.toast.imported', { n: imported }));
    }
    const hidden = Math.max(0, skipped.length - ERROR_TOAST_CAP);
    if (skipped.length > 0) {
      toast.warning(
        hidden > 0
          ? t('pcCollection.toast.skippedCapped', {
              skipped: skipped.length,
              hidden,
            })
          : t('pcCollection.toast.skipped', { skipped: skipped.length }),
      );
      for (const reason of skipped.slice(0, ERROR_TOAST_CAP))
        toast.error(reason);
    }
  };

  const patchDraft = (key: string, patch: Partial<Draft>) =>
    setDrafts((rows) =>
      rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );

  const removeDraft = (key: string) =>
    setDrafts((rows) => rows.filter((r) => r.key !== key));

  const items = drafts.map(toItem);
  const canSave =
    drafts.length > 0 && items.every((i) => i !== null) && !saving;

  const saveDrafts = async () => {
    if (!canSave) return;
    // The batch runner folds per-item failures into `skipped`, but a rejection
    // of the mutation itself (the backend went away mid-batch) would otherwise
    // be an unhandled promise from an onClick — the operator would see nothing
    // happen and the drafts would stay on screen with no explanation.
    let result: { created: number; skipped: string[] };
    try {
      result = await batchCreate.mutateAsync(
        items.filter((i): i is PcQueueItem => i !== null),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return;
    }
    const { created, skipped } = result;
    const hidden = Math.max(0, skipped.length - ERROR_TOAST_CAP);
    if (skipped.length === 0) {
      toast.success(t('pcAdd.toast.queueDone', { n: created }));
    } else {
      const summary =
        hidden > 0
          ? t('pcAdd.toast.queueSkippedCapped', {
              n: created,
              skipped: skipped.length,
              hidden,
            })
          : t('pcAdd.toast.queueSkipped', {
              n: created,
              skipped: skipped.length,
            });
      if (created > 0) toast.success(summary);
      else toast.warning(summary);
    }
    for (const reason of skipped.slice(0, ERROR_TOAST_CAP)) toast.error(reason);
    // ponytail: clears every draft, failures included — a failed one is
    // re-imported by hand. Per-row retry needs per-row error state; add it if
    // imports start failing in practice.
    setDrafts([]);
  };

  const scanned = offers?.length ?? 0;

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('pcCollection.title')}</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          {t('pcCollection.subtitle')}
        </Text>
      </div>

      <GachaPipelineHint current="product" />

      <div className="flex flex-col gap-y-6 px-6 py-6">
        {/* Step 1 — scan */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="small"
            variant="secondary"
            type="button"
            onClick={() => void scan(true)}
            isLoading={scanning}
          >
            {offers === null
              ? t('pcCollection.fetch')
              : t('pcCollection.refetch')}
          </Button>
          {scanning && (
            <Button
              size="small"
              variant="secondary"
              type="button"
              onClick={() => {
                stopScanRef.current = true;
              }}
            >
              {t('pcCollection.stop')}
            </Button>
          )}
          {!scanning && offers !== null && !exhausted && (
            <Button
              size="small"
              variant="secondary"
              type="button"
              onClick={() => void scan(false)}
            >
              {t('pcCollection.continue')}
            </Button>
          )}
          {offers !== null && (
            <Text className="text-ui-fg-subtle" size="small">
              {t('pcCollection.progress', {
                scanned,
                pages: scannedPages,
                shown: matches.length,
              })}
            </Text>
          )}
          {exhausted && (
            <StatusBadge color="green">
              {t('pcCollection.complete')}
            </StatusBadge>
          )}
          {!exhausted && !scanning && offers !== null && scanError === null && (
            <StatusBadge color="orange">
              {t('pcCollection.partial')}
            </StatusBadge>
          )}
        </div>

        {scanError !== null && !scanning && (
          <Text className="text-ui-fg-error" size="small">
            {scanError}
          </Text>
        )}

        {offers !== null && scanned === 0 && !scanning && scanError === null && (
          <Text className="text-ui-fg-subtle" size="small">
            {t('pcCollection.empty')}
          </Text>
        )}

        {/* Step 2 — narrow + pick */}
        {offers !== null && scanned > 0 && (
          <div className="flex flex-col gap-y-3">
            <div className="flex flex-wrap items-center gap-4">
              <Input
                className="max-w-xs"
                placeholder={t('pcCollection.filter')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <Switch
                  id="pc-cards-only"
                  checked={cardsOnly}
                  onCheckedChange={setCardsOnly}
                />
                <Label size="small" htmlFor="pc-cards-only">
                  {t('pcCollection.cardsOnly')}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="pc-graded-only"
                  checked={gradedOnly}
                  onCheckedChange={setGradedOnly}
                />
                <Label size="small" htmlFor="pc-graded-only">
                  {t('pcCollection.gradedOnly')}
                </Label>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="small"
                variant="secondary"
                type="button"
                onClick={toggleAllVisible}
                disabled={visible.length === 0}
              >
                {allVisibleSelected
                  ? t('pcCollection.deselectAll')
                  : t('pcCollection.selectAll')}
              </Button>
              {picked.length > 0 && (
                <Button
                  size="small"
                  variant="secondary"
                  type="button"
                  onClick={() => setSelected({})}
                >
                  {t('pcCollection.clearSelection', { n: picked.length })}
                </Button>
              )}
              <Button
                size="small"
                type="button"
                onClick={importSelected}
                isLoading={importing !== null}
                disabled={picked.length === 0}
              >
                {t('pcCollection.import', { n: picked.length })}
              </Button>
              {importing !== null && (
                <>
                  <Button
                    size="small"
                    variant="secondary"
                    type="button"
                    onClick={() => {
                      stopImportRef.current = true;
                    }}
                  >
                    {t('pcCollection.stopImport')}
                  </Button>
                  <Text className="text-ui-fg-subtle" size="small">
                    {t('pcCollection.importing', importing)}
                  </Text>
                </>
              )}
            </div>

            {matches.length > visible.length && (
              <Text className="text-ui-fg-subtle text-xs">
                {t('pcCollection.rowCap', {
                  shown: visible.length,
                  total: matches.length,
                })}
              </Text>
            )}

            <div className="max-h-[28rem] overflow-y-auto rounded-lg border">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell />
                    {sortHeader('item', t('pcCollection.col.item'))}
                    {sortHeader('pcTag', t('pcCollection.col.pcTag'))}
                    {sortHeader('tier', t('pcCollection.col.tier'))}
                    {sortHeader('offerValue', t('pcCollection.col.offerValue'))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {visible.map((o) => {
                    const key = offerKey(o);
                    return (
                      <Table.Row key={key}>
                        <Table.Cell>
                          <Checkbox
                            checked={!!selected[key]}
                            aria-label={t('pcCollection.selectRow', {
                              name: o.name || o.product_id,
                              tag: o.include || '—',
                            })}
                            onCheckedChange={(v) =>
                              setSelected((s) => ({ ...s, [key]: v === true }))
                            }
                          />
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex items-center gap-3">
                            {o.image ? (
                              <img
                                src={resolveImageUrl(o.image)}
                                alt=""
                                loading="lazy"
                                className="h-10 w-8 rounded object-contain"
                              />
                            ) : (
                              <div className="border-ui-border-base bg-ui-bg-subtle text-ui-fg-muted flex h-10 w-8 items-center justify-center rounded border text-xs">
                                —
                              </div>
                            )}
                            <div className="flex flex-col">
                              <span className="text-sm font-medium">
                                {o.name}
                              </span>
                              <span className="text-ui-fg-subtle text-xs">
                                {o.set}
                              </span>
                            </div>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="text-ui-fg-subtle text-xs">
                            {o.include || o.condition || '—'}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          {o.grade ?? (
                            <StatusBadge color="grey">
                              {t('pcCollection.tierUnmapped')}
                            </StatusBadge>
                          )}
                        </Table.Cell>
                        <Table.Cell>{usdLabel(o.value_usd)}</Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table>
            </div>
            <Text className="text-ui-fg-subtle text-xs">
              {t('pcCollection.valueHint')}
            </Text>
          </div>
        )}

        {/* Step 3 — finish each import: tier, units, label, pixel Pokémon */}
        {drafts.length > 0 && (
          <div className="flex flex-col gap-y-4">
            <Heading level="h3">
              {t('pcCollection.drafts', { n: drafts.length })}
            </Heading>
            {drafts.map((d) => {
              return (
                <div
                  key={d.key}
                  className="bg-ui-bg-subtle flex flex-col gap-y-4 rounded-lg p-4"
                >
                  <div className="flex items-start gap-4">
                    <img
                      src={resolveImageUrl(d.image)}
                      alt=""
                      loading="lazy"
                      className="border-ui-border-base h-20 w-14 shrink-0 rounded border object-contain"
                    />
                    <div className="flex flex-1 flex-col">
                      <span className="text-sm font-medium">{d.name}</span>
                      <span className="text-ui-fg-subtle text-xs">{d.set}</span>
                      <span className="text-ui-fg-muted text-xs">
                        {t('pcCollection.slabLine', {
                          tag: d.include || '—',
                          grader:
                            d.grader === ''
                              ? t('pcCollection.noGrader')
                              : `${d.grader} ${d.grade}`,
                        })}
                      </span>
                      {d.merged > 1 && (
                        <span className="text-ui-fg-muted text-xs">
                          {t('pcCollection.merged', { n: d.merged })}
                        </span>
                      )}
                    </div>
                    <IconButton
                      size="small"
                      variant="transparent"
                      aria-label={t('pcCollection.remove')}
                      onClick={() => removeDraft(d.key)}
                    >
                      <XMark className="h-3 w-3" />
                    </IconButton>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-y-2">
                      <Label
                        size="small"
                        weight="plus"
                        htmlFor={`draft-${d.key}-tier`}
                      >
                        {t('pcAdd.grade.label')}
                      </Label>
                      <Select
                        value={d.pcGrade === '' ? NO_TIER : d.pcGrade}
                        onValueChange={(v) =>
                          patchDraft(d.key, { pcGrade: v === NO_TIER ? '' : v })
                        }
                      >
                        <Select.Trigger id={`draft-${d.key}-tier`}>
                          <Select.Value
                            placeholder={t('pcCollection.pickTier')}
                          />
                        </Select.Trigger>
                        <Select.Content>
                          <Select.Item value={NO_TIER}>
                            {t('pcCollection.pickTier')}
                          </Select.Item>
                          {d.prices.map((p) => (
                            <Select.Item key={p.grade} value={p.grade}>
                              {p.grade}: {usdLabel(p.usd)}
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-y-2">
                      <Label
                        size="small"
                        weight="plus"
                        htmlFor={`draft-${d.key}-stock`}
                      >
                        {t('pcAdd.stock.label')}
                      </Label>
                      <Input
                        id={`draft-${d.key}-stock`}
                        type="number"
                        min={0}
                        max={MAX_STOCK}
                        step={1}
                        className="max-w-[8rem]"
                        value={d.stock}
                        onChange={(e) =>
                          patchDraft(d.key, { stock: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-y-2">
                      <Label
                        size="small"
                        weight="plus"
                        htmlFor={`draft-${d.key}-label-year`}
                      >
                        {t('cards.form.labelYear')}
                      </Label>
                      <Input
                        id={`draft-${d.key}-label-year`}
                        maxLength={64}
                        value={d.labelYear}
                        onChange={(e) =>
                          patchDraft(d.key, { labelYear: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-y-2">
                      <Label
                        size="small"
                        weight="plus"
                        htmlFor={`draft-${d.key}-label-note`}
                      >
                        {t('cards.form.labelNote')}
                      </Label>
                      <Input
                        id={`draft-${d.key}-label-note`}
                        maxLength={64}
                        value={d.labelNote}
                        onChange={(e) =>
                          patchDraft(d.key, { labelNote: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <GraderGradeSelect
                    grader={d.grader}
                    grade={d.grade}
                    onChange={(v) => patchDraft(d.key, v)}
                    idPrefix={`draft-${d.key}`}
                  />

                  <div className="flex flex-col gap-y-2">
                    <CardPokemonFields
                      value={d.pokemon}
                      onChange={(p) =>
                        patchDraft(d.key, { pokemon: { ...d.pokemon, ...p } })
                      }
                      suggestionName={d.name}
                      idPrefix={`draft-${d.key}`}
                    />
                    {d.pokemon.pixel_pokemon_id === null && (
                      <Text size="small" className="text-ui-fg-error">
                        {t('pcAdd.pixel.required')}
                      </Text>
                    )}
                  </div>
                </div>
              );
            })}

            <Button onClick={saveDrafts} isLoading={saving} disabled={!canSave}>
              {t('pcCollection.save', { n: drafts.length })}
            </Button>
          </div>
        )}
      </div>
    </Container>
  );
};

export default AddFromPcCollectionPage;
