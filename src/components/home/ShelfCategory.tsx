'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import type { PackTab } from '@/lib/packs-data';

const ShelfCategoryContext = createContext<{
  active: string;
  pick: (id: string) => void;
  /** The pack centred in the home carousel (its slug), once the stage has one. */
  pack?: string | null;
  centre?: (slug: string | null) => void;
} | null>(null);

/** The franchise picked on the home shelf: the shelf shows its ladder and the
 *  pull history below it follows (on the 3D home, the centred pack too). The
 *  first tab with packs is the default. */
export function ShelfCategoryProvider({
  categories,
  children,
}: {
  categories: PackTab[];
  children?: ReactNode;
}) {
  const first = categories.find((c) => !c.soon)?.id ?? '';
  const [picked, pick] = useState(first);
  const [pack, centre] = useState<string | null>(null);
  // A refresh can drop the picked franchise; fall back to the first one left.
  const active = categories.some((c) => c.id === picked && !c.soon)
    ? picked
    : first;
  return (
    <ShelfCategoryContext.Provider value={{ active, pick, pack, centre }}>
      {children}
    </ShelfCategoryContext.Provider>
  );
}

export function useShelfCategory() {
  const value = useContext(ShelfCategoryContext);
  if (!value) {
    throw new Error('useShelfCategory needs a ShelfCategoryProvider');
  }
  return value;
}
