import { useState } from 'react';
import { Table } from '@medusajs/ui';

export type SortDir = 'asc' | 'desc';
export type SortState<K extends string> = { key: K; dir: SortDir };

// Shared header-sort state + renderer for admin tables. Extracted from
// inventory/list (client-side sort) and purchase-invoices (server-side sort) —
// the hook is agnostic: client pages feed `sort` into a useMemo comparator,
// server pages serialize it as `key:dir` for the endpoint.
//
// `initial: null` = unsorted, keep the source order (pages whose default order
// is load-bearing — packs rank order, deposits' pending-oldest-first queue —
// must start null so merely opening the page doesn't override it).
export function useTableSort<K extends string>(
  initial: SortState<K> | null,
  opts: { onChange?: () => void } = {},
) {
  const [sort, setSort] = useState<SortState<K> | null>(initial);

  // A new column starts descending (newest/biggest first, what an operator
  // scanning a list wants); clicking the active column flips it.
  const toggleSort = (key: K) => {
    setSort((s) => ({
      key,
      dir: s?.key === key && s.dir === 'desc' ? 'asc' : 'desc',
    }));
    opts.onChange?.();
  };

  // `align` right-aligns the label over right-aligned (numeric) cells.
  const sortHeader = (key: K, label: string, align = false) => {
    const active = sort?.key === key;
    const dir = sort?.dir;
    return (
      <Table.HeaderCell
        aria-sort={
          active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'
        }
      >
        {/* Real button, not an onClick on the cell: a sortable header has to be
            reachable by keyboard. */}
        {/* `w-full justify-end`, NOT `ml-auto`: Tailwind's `flex` makes this a
            block-level flex container with width:auto, and an auto margin on a
            width:auto block resolves to 0 — so ml-auto would leave every
            numeric header left-aligned over right-aligned cells. */}
        <button
          type="button"
          className={`hover:text-ui-fg-base flex items-center gap-1 whitespace-nowrap ${align ? 'w-full justify-end' : ''}`}
          onClick={() => toggleSort(key)}
        >
          {label}
          <span aria-hidden="true">
            {active ? (dir === 'asc' ? '↑' : '↓') : ''}
          </span>
        </button>
      </Table.HeaderCell>
    );
  };

  // For pages that reuse one mounted component across a route-param change
  // (e.g. the pack editor across `:slug`) and must drop per-view sort state.
  const resetSort = () => setSort(initial);

  return { sort, toggleSort, sortHeader, resetSort };
}
