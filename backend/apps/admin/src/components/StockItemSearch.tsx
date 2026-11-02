import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Label } from '@medusajs/ui';
import { useInventory } from '../lib/queries';
import { rm } from '../lib/format';
import { resolveImageUrl } from '../lib/image-url';

export type StockSearchItem = {
  handle: string;
  name: string;
  /** MYR; null when the product has no FMV — the forms then leave the
   *  FMV (and cost) empty for the operator instead of saving RM 0.00. */
  fmv: number | null;
};

// Photos by handle, off the same GET /admin/inventory rows the Stock page
// reads — react-query shares the cache, so the line tables below cost no
// extra request once the Stock page or the picker has loaded it.
const useStockPhotos = (): Map<string, string | null> => {
  const { data } = useInventory();
  return useMemo(
    () => new Map((data?.rows ?? []).map((r) => [r.handle, r.photo])),
    [data],
  );
};

const Thumb = ({ photo }: { photo: string | null | undefined }) =>
  photo ? (
    <img
      src={resolveImageUrl(photo)}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-10 w-10 shrink-0 rounded object-cover"
    />
  ) : (
    <span className="bg-ui-bg-subtle h-10 w-10 shrink-0 rounded" />
  );

/** A stock-form line's Item cell: card photo, name and handle (operator
 *  request 2026-10-28 — "purchase invoice and GRN should show pictures"). */
export const StockLineItem = ({
  handle,
  name,
}: {
  handle: string;
  name: string;
}) => {
  const photos = useStockPhotos();
  return (
    <div className="flex items-center gap-3">
      <Thumb photo={photos.get(handle)} />
      <span className="break-words">
        {name}
        <span className="text-ui-fg-muted ml-2 text-xs">{handle}</span>
      </span>
    </div>
  );
};

/**
 * "Add item" for the stock forms (New purchase invoice, New goods receive
 * note). Clicking the box opens a pick-list built from the Stock page's own
 * rows — photo, name, SKU, On hand, Need, FMV — as the operator asked
 * 2026-10-28; typing filters it. Cards some order still needs come first.
 * Handle/name/FMV come from the PICKED row, never from typed text —
 * card_handle is what the weighted-average cost, On hand and the reversal
 * match key off, so a free-typed handle would silently create a second stock
 * bucket. Rows are products, which is also exactly what the save routes
 * accept (they refuse a card_handle with no product).
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
  const [open, setOpen] = useState(false);
  // Keyboard cursor in the open list (combobox + aria-activedescendant: focus
  // stays in the input, arrows move this, Enter picks it).
  const [active, setActive] = useState(0);
  const { data, isLoading, isError } = useInventory();

  const rows = useMemo(
    () =>
      [...(data?.rows ?? [])].sort(
        (a, b) => b.to_procure - a.to_procure || a.name.localeCompare(b.name),
      ),
    [data],
  );
  const hits = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.sku.toLowerCase().includes(q) ||
            r.handle.toLowerCase().includes(q),
        )
      : rows;
  }, [rows, filter]);
  const visible = hits.slice(0, 50);
  const optionId = (i: number) => `${id}-opt-${i}`;

  const pick = (r: (typeof visible)[number]) => {
    onPick({ handle: r.handle, name: r.name, fmv: r.fmv });
    setFilter('');
    setActive(0);
    // Close so the new line is visible under the box; a click or ArrowDown
    // opens the list again for the next card.
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-y-2 border-t px-6 py-4">
      <Label size="small" weight="plus" htmlFor={id}>
        {t('inventory.itemSearch.label')}
      </Label>
      <div className="relative max-w-3xl">
        <Input
          id={id}
          type="search"
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={
            open && visible.length > 0 ? optionId(active) : undefined
          }
          placeholder={t('inventory.itemSearch.placeholder')}
          value={filter}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // preventDefault: Escape in a search box also clears the text,
              // whose onChange would open the list straight back up.
              e.preventDefault();
              setOpen(false);
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (!open) return setOpen(true);
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive((i) =>
                Math.min(
                  Math.max(i + step, 0),
                  Math.max(visible.length - 1, 0),
                ),
              );
            } else if (e.key === 'Enter' && open && visible[active]) {
              e.preventDefault(); // never submit the surrounding form
              pick(visible[active]);
            }
          }}
          onChange={(e) => {
            setFilter(e.target.value);
            setActive(0);
            setOpen(true);
          }}
        />
        {open ? (
          <div
            id={`${id}-list`}
            role="listbox"
            // On the whole list, not just the rows: a mousedown on its
            // scrollbar or a divider would otherwise blur the input and close
            // the list mid-scroll. Rows are never focused, so focus stays put.
            onMouseDown={(e) => e.preventDefault()}
            className="bg-ui-bg-base shadow-elevation-flyout absolute z-20 mt-1 max-h-96 w-full divide-y overflow-y-auto rounded-lg border"
          >
            {visible.map((r, i) => (
              <button
                key={r.handle}
                id={optionId(i)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(r)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left ${i === active ? 'bg-ui-bg-base-hover' : ''}`}
              >
                <Thumb photo={r.photo} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    {r.name}
                    <span className="text-ui-fg-muted ml-2 text-xs font-normal">
                      {r.graded ? t('inventory.graded') : t('inventory.raw')}
                    </span>
                  </span>
                  <span className="text-ui-fg-muted truncate text-xs">
                    {r.sku}
                  </span>
                </span>
                <span className="text-ui-fg-subtle whitespace-nowrap text-xs tabular-nums">
                  {t('inventory.onHand')} {r.on_hand}
                </span>
                <span
                  className={`whitespace-nowrap text-xs tabular-nums ${r.to_procure > 0 ? 'text-ui-fg-error' : 'text-ui-fg-subtle'}`}
                >
                  {t('procurement.col.need')} {r.to_procure}
                </span>
                <span className="w-24 whitespace-nowrap text-right text-xs tabular-nums">
                  {rm(r.fmv)}
                </span>
              </button>
            ))}
            {visible.length === 0 ? (
              <div className="text-ui-fg-subtle px-4 py-3 text-sm">
                {isLoading
                  ? t('inventory.itemSearch.loading')
                  : isError
                    ? t('inventory.itemSearch.loadError')
                    : rows.length === 0
                      ? t('inventory.itemSearch.none')
                      : t('inventory.itemSearch.noMatch')}
              </div>
            ) : hits.length > visible.length ? (
              <div className="text-ui-fg-muted px-4 py-2 text-xs">
                {t('inventory.itemSearch.more', {
                  shown: visible.length,
                  total: hits.length,
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};
