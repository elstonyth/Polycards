'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import type { PackTab } from '@/lib/packs-data';

const ShelfCategoryContext = createContext<{
  active: string;
  pick: (id: string) => void;
}>({ active: '', pick: () => {} });

/** The franchise picked on the home shelf: the shelf shows its ladder and the
 *  pull history below it follows. The first tab with packs is the default. */
export function ShelfCategoryProvider({
  categories,
  children,
}: {
  categories: PackTab[];
  children: ReactNode;
}) {
  const first = categories.find((c) => !c.soon)?.id ?? '';
  const [picked, pick] = useState(first);
  // A refresh can drop the picked franchise; fall back to the first one left.
  const active = categories.some((c) => c.id === picked && !c.soon)
    ? picked
    : first;
  return (
    <ShelfCategoryContext.Provider value={{ active, pick }}>
      {children}
    </ShelfCategoryContext.Provider>
  );
}

export const useShelfCategory = () => useContext(ShelfCategoryContext);
