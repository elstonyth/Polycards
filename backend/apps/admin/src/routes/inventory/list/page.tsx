import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Checkbox,
  Container,
  Heading,
  Input,
  Table,
  Text,
  toast,
} from '@medusajs/ui';
import { ArchiveBox } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useEligibleProducts,
  useInventory,
  useInvalidateInventory,
  useRegisterCard,
} from '../../../lib/queries';
import {
  exportInventoryXlsx,
  type InventoryRow,
} from '../../../lib/admin-rest';
import { orderDateTime, rm } from '../../../lib/format';
import { resolveImageUrl } from '../../../lib/image-url';
import { useTableSort } from '../../../lib/use-table-sort';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';

// NOT `src/routes/inventory/page.tsx`, which is what spec §3.3's task brief
// asked for. Medusa's dashboard already owns the whole `/inventory` domain
// (Inventory Items, plus /inventory/create, /inventory/stock, /inventory/:id
// and a G+I keyboard shortcut), and @mercurjs/admin's mergeRoutes matches a
// custom route to a core one BY PATH and then spreads the custom object over
// it — so a page at `/inventory` REPLACES the core Inventory Items list
// outright and orphans its children (this page renders no <Outlet/>). Proven
// by running the shipped bundle's own createRouteMap/mergeRoutes plus
// react-router's matchRoutes over the result. `/inventory/list` is additive:
// `list` matches neither the core index ('') nor its `:id`, so it is pushed as
// a sibling and every core URL still resolves to core.
//
// rank 0 puts this above "Add from PriceCharting" (1) and "Purchase Invoices"
// (2) in the Inventory sidebar group. `nested` and `label` are independent of
// the URL, so the sidebar still reads exactly as specced.
export const config: RouteConfig = {
  label: 'Inventory',
  icon: ArchiveBox,
  nested: '/inventory',
  rank: 0,
};

// The route truncates ?q= at 100 chars. Matching the input's maxLength keeps
// the operator from typing a filter the server will never see.
const MAX_Q = 100;

type SortKey =
  | 'name'
  | 'fmv'
  | 'price'
  | 'cost'
  | 'created_at'
  | 'on_hand'
  | 'in_vault'
  | 'requested'
  | 'shipped';

// Nullable numerics all sort as -Infinity rather than a sentinel like -1:
// on_hand can legitimately be NEGATIVE (oversold), and -1 would rank a real
// deficit above "unknown". -Infinity keeps "unknown" strictly last on desc and
// strictly first on asc for every column, and two unknowns compare equal
// without ever producing NaN (which is why this compares with < / > rather
// than subtracting).
const sortValue = (r: InventoryRow, key: SortKey): number => {
  switch (key) {
    case 'fmv':
      return r.fmv ?? Number.NEGATIVE_INFINITY;
    case 'price':
      return r.price ?? Number.NEGATIVE_INFINITY;
    case 'cost':
      return r.cost ?? Number.NEGATIVE_INFINITY;
    case 'on_hand':
      return r.on_hand ?? Number.NEGATIVE_INFINITY;
    case 'created_at':
      return Date.parse(r.created_at);
    case 'in_vault':
      return r.in_vault;
    case 'requested':
      return r.requested;
    case 'shipped':
      return r.shipped;
    default:
      return 0;
  }
};

const InventoryListPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const { sort, sortHeader } = useTableSort<SortKey>({
    key: 'created_at',
    dir: 'desc',
  });

  // 300 ms debounce, same as Purchase Invoices and Players. Not cosmetic here:
  // this endpoint pages the WHOLE product catalog, then makes five sequential
  // per-handle service calls (stock, skus, buckets, cost, listings), each
  // checking out its own pool connection. A request per keystroke is the shape
  // of this repo's "pool is probably full" failures.
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Blank filter passed as undefined, never '' — qk.inventory() and
  // qk.inventory('') are the same key by construction, but keeping the call
  // site honest matches the sibling pages.
  const { data, isError } = useInventory(q || undefined);
  const registerCard = useRegisterCard();
  const invalidateInventory = useInvalidateInventory();

  // The register endpoint wants market_value in RAW USD; this list's own `fmv`
  // is already MYR-converted for display, so it must NOT be the source. The
  // eligible-products route carries the unconverted product.metadata.fmv (and
  // the staged set/grader/grade), which is what the single-card register modal
  // already prefills from. Fetched only once something is selected — it is a
  // second full-catalog read and this page is heavy enough already.
  //
  // ponytail: eligible-products is capped at CATALOG_CAP = 1000 rows while
  // this list is uncapped (pageAll). Past 1000 products the bulk tool starts
  // reporting "no FMV recorded" for rows that do have one; the fix belongs in
  // that route (it already logs when it hits the cap), not here.
  const { data: eligible } = useEligibleProducts(selected.size > 0);
  const eligibleByHandle = useMemo(
    () => new Map((eligible ?? []).map((p) => [p.handle, p])),
    [eligible],
  );

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    if (!sort) return list;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const key = sort.key;
    list.sort((a, b) => {
      if (key === 'name') {
        return dir * a.name.localeCompare(b.name);
      }
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      return dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });
    return list;
  }, [data, sort]);

  const pageIds = rows.map((r) => r.handle);
  const allOnPage =
    pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPage = pageIds.some((id) => selected.has(id));

  // Decide add-vs-remove from `prev` inside the updater, not from the rendered
  // `allOnPage`: with keepPreviousData a refetch can swap `rows` between the
  // click and the update, and a stale flag turns "select all" into a no-op.
  // Copied verbatim from routes/deliveries/page.tsx.
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      const everyOnPage =
        pageIds.length > 0 && pageIds.every((id) => prev.has(id));
      for (const id of pageIds) {
        if (everyOnPage) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Partial success by design, same summary shape as the deliveries bulk tool.
  // Two skip classes, both counted rather than silently dropped: a row that is
  // already a gacha card (selecting one is not an error, but it must not read
  // as "0 created" with no reason), and a row with NO recorded FMV — the
  // register endpoint accepts market_value 0, and 0 is the buyback lever, so a
  // missing FMV must never be defaulted.
  const bulkListToGachaCard = async () => {
    // Iterating `rows` rather than `[...selected]` is what keeps this to what
    // is on screen RIGHT NOW — the selection Set outlives a search change, and
    // keepPreviousData keeps the OLD rows checkable for the whole refetch
    // window, so a handle ticked mid-flight can linger in `selected` after it
    // has left the list. (deliveries/page.tsx iterates the selection instead
    // and therefore needs an explicit pageIds intersection; here the filter
    // source already IS the visible set, so a second guard would be a no-op.)
    const targets = rows.filter((r) => selected.has(r.handle));
    let created = 0;
    const skipped: string[] = [];
    for (const target of targets) {
      if (target.is_card) {
        skipped.push(`${target.name}: ${t('inventory.skipAlreadyCard')}`);
        continue;
      }
      const product = eligibleByHandle.get(target.handle);
      if (!product || product.fmv === null) {
        skipped.push(`${target.name}: ${t('inventory.skipNoFmv')}`);
        continue;
      }
      try {
        // set / grader / grade are sourced from the SAME staged metadata the
        // register modal prefills from, NOT sent blank: coerceRegisterCardBody
        // runs them through optStr, which does not fall back to the product's
        // metadata the way pc_product_id / pixel_pokemon_id / label_* do. A
        // blank grader would register a PSA 10 as an ungraded card AND skip
        // the slab bake (create-card.ts feeds input.grader to bakeSlabImage),
        // and this list's own GRADED/RAW column would then flip to RAW.
        //
        // Everything else is omitted ON PURPOSE so create-card.ts inherits it
        // from the product's metadata.
        await registerCard.mutateAsync({
          product_id: target.product_id,
          set: product.set ?? '',
          grader: product.grader ?? '',
          grade: product.grade ?? '',
          market_value: product.fmv,
        });
        created += 1;
      } catch (e) {
        skipped.push(
          `${target.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // useRegisterCard only invalidates qk.cards / qk.eligibleProducts — it
    // predates this epic. Without this every row the loop just registered
    // would stay is_card:false on screen, and re-running the tool against it
    // would 400 on create-card's duplicate-handle guard. Invalidating the
    // NAMESPACE (not refetching this one query) also fixes the rows cached
    // under the operator's other searches.
    if (created > 0) {
      await invalidateInventory();
    }
    if (created === 0 && skipped.length > 0) {
      toast.warning(t('inventory.bulkNone', { skipped: skipped.length }));
    } else if (skipped.length > 0) {
      toast.success(
        t('inventory.bulkDoneSkipped', {
          n: created,
          skipped: skipped.length,
        }),
      );
    } else {
      toast.success(t('inventory.bulkDone', { n: created }));
    }
    // Capped at 5 so a 100-row mistake does not bury the screen.
    for (const reason of skipped.slice(0, 5)) {
      toast.error(reason);
    }
    // LOAD-BEARING for useRegisterCard's refetchType:'none' (queries.ts): this
    // unconditional clear is what makes the NEXT selection an enabled
    // false->true transition, and that transition is the only thing that
    // refetches the eligible-products map this run just invalidated. Keeping
    // the selection after a run would leave that map stale for the session.
    setSelected(new Set());
  };

  // Exports `q`, the APPLIED filter, and never `search`: `search` is the raw
  // input and only becomes the filter 300 ms later, so exporting it would hand
  // back a sheet for a search the operator is still typing. Blank goes as
  // undefined so the query string is omitted entirely, matching useInventory.
  //
  // Guarded by `exporting` rather than left to fire freely: this endpoint pages
  // the WHOLE product catalog and then makes five sequential per-handle service
  // calls, each checking out its own pool connection -- the same cost that made
  // the search box debounce in the first place, and an impatient double-click
  // would pay it twice concurrently.
  const runExport = () => {
    setExporting(true);
    exportInventoryXlsx(q || undefined)
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setExporting(false));
  };

  return (
    <Container className="divide-y p-0">
      <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">{t('inventory.title')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {/* `pageSubtitle`, NOT `subtitle`: the dashboard merges locales with
                a RECURSIVE deepMerge whose leaf-vs-anything branch OVERWRITES,
                and core Medusa already defines `inventory.subtitle` ("Manage
                your inventory items") for its own Inventory Items screen. A key
                named `subtitle` here silently retitles a core page we went out
                of our way to keep intact. Nesting under `inventory` is still
                correct — the other keys are additive and deepMerge recurses. */}
            {t('inventory.pageSubtitle')}
          </Text>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="search"
            className="w-72"
            maxLength={MAX_Q}
            placeholder={t('inventory.searchPlaceholder')}
            aria-label={t('inventory.searchPlaceholder')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected(new Set());
            }}
          />
          <Button
            variant="secondary"
            isLoading={exporting}
            disabled={exporting}
            onClick={runExport}
          >
            {t('inventory.export')}
          </Button>
        </div>
      </div>

      {selected.size > 0 && (
        <div
          className="bg-ui-bg-subtle flex flex-wrap items-center gap-3 px-6 py-3"
          role="region"
          aria-label={t('inventory.listToCard')}
        >
          <Text size="small" weight="plus">
            {t('inventory.selected', { n: selected.size })}
          </Text>
          {/* Spins until eligible-products is in hand: it is the only source of
              raw-USD FMV, so firing early would skip every row for "no FMV". */}
          <Button
            size="small"
            onClick={bulkListToGachaCard}
            isLoading={!eligible || registerCard.isPending}
            disabled={!eligible || registerCard.isPending}
          >
            {t('inventory.listToCard')}
          </Button>
        </div>
      )}

      {isError ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">{t('inventory.loadError')}</Text>
        </div>
      ) : !data ? (
        // Body-swap, never a top-level early return: an early return throws
        // away the heading and the search box, so a slow refetch would rip the
        // operator's own filter off the screen.
        <div className="px-6 py-8">
          <LoadingSkeleton />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">
            {q ? t('inventory.noResults') : t('inventory.empty')}
          </Text>
        </div>
      ) : (
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label={t('inventory.title')}
        >
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell className="w-10">
                  <Checkbox
                    aria-label={t('inventory.selectAll')}
                    checked={
                      allOnPage ? true : someOnPage ? 'indeterminate' : false
                    }
                    onCheckedChange={toggleAll}
                  />
                </Table.HeaderCell>
                <Table.HeaderCell>{t('inventory.photo')}</Table.HeaderCell>
                {sortHeader('name', t('inventory.name'))}
                <Table.HeaderCell>{t('inventory.sku')}</Table.HeaderCell>
                <Table.HeaderCell>{t('inventory.titleCol')}</Table.HeaderCell>
                {sortHeader('fmv', t('inventory.fmv'), true)}
                {sortHeader('price', t('inventory.price'), true)}
                {sortHeader('cost', t('inventory.cost'), true)}
                {sortHeader('created_at', t('inventory.created'), true)}
                {sortHeader('on_hand', t('inventory.onHand'), true)}
                {sortHeader('in_vault', t('inventory.inVault'), true)}
                {sortHeader('requested', t('inventory.requested'), true)}
                {sortHeader('shipped', t('inventory.shipped'), true)}
                <Table.HeaderCell className="text-right">
                  {t('inventory.listingShow')}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r) => (
                <Table.Row
                  key={r.handle}
                  className="cursor-pointer"
                  onClick={() => navigate(`/inventory/list/${r.handle}`)}
                >
                  {/* stopPropagation so ticking a row does not also navigate. */}
                  <Table.Cell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={t('inventory.selectOne', { name: r.name })}
                      checked={selected.has(r.handle)}
                      onCheckedChange={() => toggleOne(r.handle)}
                    />
                  </Table.Cell>
                  <Table.Cell>
                    {/* `r.photo &&`, not just a src: an empty string resolves to
                        the page URL and gets refetched as an image. */}
                    {r.photo && (
                      <img
                        src={resolveImageUrl(r.photo)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-10 w-10 shrink-0 rounded object-cover"
                      />
                    )}
                  </Table.Cell>
                  <Table.Cell className="break-words">
                    {r.name}
                    {!r.is_card && (
                      <span className="text-ui-fg-subtle ml-1 text-xs">
                        ({t('inventory.notACard')})
                      </span>
                    )}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle break-words">
                    {r.sku}
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">
                    {r.graded ? t('inventory.graded') : t('inventory.raw')}
                  </Table.Cell>
                  {/* rm() already renders null as an em dash and 0 as RM 0.00,
                      so these stay unguarded — do NOT reintroduce a truthiness
                      test here, `cost` 0 (bought and free) and `cost` null (no
                      purchase history) are different facts. */}
                  <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                    {rm(r.fmv)}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                    {rm(r.price)}
                  </Table.Cell>
                  <Table.Cell
                    className="text-right tabular-nums whitespace-nowrap"
                    title={r.cost === null ? t('inventory.noCost') : undefined}
                  >
                    {rm(r.cost)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle text-right whitespace-nowrap">
                    {orderDateTime(r.created_at)}
                  </Table.Cell>
                  {/* `??`, never `||`: on_hand 0 means "tracked, nothing
                      shippable" and must render as 0, not as the untracked
                      em dash. (null ?? 0) < 0 is false, so an untracked row is
                      never coloured as a deficit. */}
                  <Table.Cell
                    className={`text-right tabular-nums ${(r.on_hand ?? 0) < 0 ? 'text-ui-fg-error' : ''}`}
                    title={
                      r.on_hand === null ? t('inventory.noStock') : undefined
                    }
                  >
                    {r.on_hand ?? '—'}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    {r.in_vault}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    {r.requested}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    {r.shipped}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    {r.listing_count}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </Container>
  );
};

export default InventoryListPage;
