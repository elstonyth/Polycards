import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Label } from '@medusajs/ui';
import { useInventory } from '../lib/queries';
import { rm } from '../lib/format';
import { resolveImageUrl } from '../lib/image-url';

export type StockSearchItem = {
  handle: string;
  name: string;
  /** MYR. */
  fmv: number;
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
  const { data } = useInventory();

  const rows = useMemo(
    () =>
      [...(data?.rows ?? [])].sort(
        (a, b) => b.to_procure - a.to_procure || a.name.localeCompare(b.name),
      ),
    [data],
  );
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const hits = q
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.sku.toLowerCase().includes(q) ||
            r.handle.toLowerCase().includes(q),
        )
      : rows;
    return hits.slice(0, 50);
  }, [rows, filter]);

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
          aria-expanded={open}
          aria-controls={`${id}-list`}
          placeholder={t('inventory.itemSearch.placeholder')}
          value={filter}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            // preventDefault: Escape in a search box also clears the text,
            // whose onChange would open the list straight back up.
            if (e.key !== 'Escape') return;
            e.preventDefault();
            setOpen(false);
          }}
          onChange={(e) => {
            setFilter(e.target.value);
            setOpen(true);
          }}
        />
        {open ? (
          <div
            id={`${id}-list`}
            role="listbox"
            className="bg-ui-bg-base shadow-elevation-flyout absolute z-20 mt-1 max-h-96 w-full divide-y overflow-y-auto rounded-lg border"
          >
            {visible.map((r) => (
              <button
                key={r.handle}
                type="button"
                role="option"
                aria-selected={false}
                // Without this the mousedown blurs the input, which closes
                // the list before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick({ handle: r.handle, name: r.name, fmv: r.fmv ?? 0 });
                  setFilter('');
                  // Close so the new line is visible under the box; a click
                  // on the box opens the list again for the next card.
                  setOpen(false);
                }}
                className="hover:bg-ui-bg-base-hover flex w-full items-center gap-3 px-4 py-2 text-left"
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
                {rows.length === 0
                  ? t('inventory.itemSearch.none')
                  : t('inventory.itemSearch.noMatch')}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};
