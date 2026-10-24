'use client';

import { useState, type ReactNode } from 'react';
import PackCategoryTabs from '@/components/PackCategoryTabs';
import type { PackCategory } from '@/lib/packs-data';

/** The home shelf's franchise switch: the server renders one ladder per
 *  category (`panels`), this shows the picked one. `categories` holds only
 *  categories with packs, first = the default. */
export default function ShelfTabs({
  categories,
  panels,
}: {
  categories: PackCategory[];
  panels: Record<string, ReactNode>;
}) {
  const [picked, setActive] = useState(categories[0]?.id ?? '');
  // A refresh can drop the picked franchise; fall back to the first one left.
  const active = categories.some((c) => c.id === picked)
    ? picked
    : (categories[0]?.id ?? '');
  return (
    <>
      {categories.length > 1 && (
        <div className="mt-4">
          <PackCategoryTabs
            categories={categories}
            active={active}
            onChange={setActive}
          />
        </div>
      )}
      {panels[active]}
    </>
  );
}
