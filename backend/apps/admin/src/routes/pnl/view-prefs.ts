import { useCallback, useState } from 'react';
import { TREE_TOTAL, TREE_VS, type TreeColumn } from './PackTreeTable';

const read = (key: string): string[] => {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
};

/** A set of ids (hidden columns, hidden sections, collapsed rows) kept in this
 *  browser, so the P&L opens the way the reader left it. */
export function useStoredSet(
  key: string,
): [ReadonlySet<string>, (id: string) => void] {
  const [set, setSet] = useState<ReadonlySet<string>>(() => new Set(read(key)));
  const toggle = useCallback(
    (id: string) =>
      setSet((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          window.localStorage.setItem(key, JSON.stringify([...next]));
        } catch {
          // Private mode or blocked storage: the choice still holds this visit.
        }
        return next;
      }),
    [key],
  );
  return [set, toggle];
}

/** The Columns menu entries of a tree: its own columns, then total and vs. */
export const treeMenuOptions = <F>(
  columns: TreeColumn<F>[],
  totalHeader: string,
  vsHeader: string,
) => [
  ...columns.map((c) => ({ id: c.id, label: c.header })),
  { id: TREE_TOTAL, label: totalHeader },
  { id: TREE_VS, label: vsHeader },
];
