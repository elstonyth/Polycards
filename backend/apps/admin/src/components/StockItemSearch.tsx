import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Label } from '@medusajs/ui';
import { useCards, useEligibleProducts, useFxRate } from '../lib/queries';
import { rm, usdToMyr } from '../lib/format';

export type StockSearchItem = {
  handle: string;
  name: string;
  /** MYR. */
  fmv: number;
  kind: 'Card' | 'Product';
};

/**
 * "Add item" for the stock forms (New purchase invoice, New goods receive
 * note): search registered gacha cards plus catalog products not yet promoted
 * to a card, and hand the picked one to `onPick`. Handle/name/FMV come from the
 * MATCHED item, never from typed text — card_handle is what the weighted-average
 * cost, On hand and the reversal match key off, so a free-typed handle would
 * silently create a second stock bucket.
 */
export const StockItemSearch = ({
  id,
  onPick,
}: {
  id: string;
  onPick: (item: StockSearchItem) => void;
}) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');

  const { data: cards } = useCards();
  // `true` is REQUIRED — useEligibleProducts takes the enabled flag positionally
  // and there is no default; the picker is always on here, unlike the register
  // modal that gates it on being open.
  const { data: eligible } = useEligibleProducts(true);
  const { data: fxData } = useFxRate();

  // fmv_snapshot is MYR (purchase-invoice-line.ts), and BOTH sources are USD:
  // AdminCard.market_value is raw USD, so cards use the already-resolved
  // priceBreakdown.marketMyr; EligibleProduct.fmv is raw USD too
  // (admin/gacha/eligible-products emits `num(meta.fmv)` unconverted), so it
  // needs the same conversion — via usdToMyr, which is the mirror of the
  // backend displayMarketPrice the card side already went through, so the two
  // halves of this list are priced identically rather than merely similarly.
  //
  // No hardcoded FX fallback: before the rate loads, usdToMyr(x, 0) is 0, and a
  // silent RM 0.00 prefill on a money record is worse than a row that is not
  // offered yet. Cards are unaffected — their MYR is already server-resolved.
  const fx = fxData?.effective ?? 0;
  const searchable = useMemo(() => {
    const fromCards = (cards ?? []).map((c) => ({
      handle: c.handle,
      name: c.name,
      fmv: c.priceBreakdown.marketMyr,
      kind: 'Card' as const,
    }));
    const cardHandles = new Set(fromCards.map((c) => c.handle));
    const fromEligible =
      fx > 0
        ? (eligible ?? [])
            .filter((p) => !cardHandles.has(p.handle))
            .map((p) => ({
              handle: p.handle,
              name: p.title,
              fmv: usdToMyr(p.fmv ?? 0, fx),
              kind: 'Product' as const,
            }))
        : [];
    return [...fromCards, ...fromEligible];
  }, [cards, eligible, fx]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return searchable.slice(0, 50);
    return searchable
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.handle.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [searchable, filter]);

  return (
    <div className="flex flex-col gap-y-2 border-t px-6 py-4">
      <Label size="small" weight="plus" htmlFor={id}>
        {t('inventory.itemSearch.label')}
      </Label>
      <Input
        id={id}
        type="search"
        className="max-w-md"
        placeholder={t('inventory.itemSearch.placeholder')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="max-h-64 max-w-md divide-y overflow-y-auto rounded-lg border">
        {visible.map((s) => (
          <button
            key={`${s.kind}-${s.handle}`}
            type="button"
            onClick={() => {
              onPick(s);
              setFilter('');
            }}
            className="hover:bg-ui-bg-base-hover flex w-full items-center gap-3 px-4 py-2 text-left"
          >
            <span className="flex-1 truncate text-sm font-medium">
              {s.name}
            </span>
            <span className="text-ui-fg-muted truncate text-xs">
              {s.handle}
            </span>
            <span className="text-ui-fg-subtle whitespace-nowrap text-xs tabular-nums">
              {rm(s.fmv)}
            </span>
          </button>
        ))}
        {visible.length === 0 ? (
          <div className="text-ui-fg-subtle px-4 py-3 text-sm">
            {searchable.length === 0
              ? t('inventory.itemSearch.none')
              : t('inventory.itemSearch.noMatch')}
          </div>
        ) : null}
      </div>
    </div>
  );
};
