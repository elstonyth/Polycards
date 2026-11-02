'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import PackCategoryTabs from '@/components/PackCategoryTabs';
import { useShelfCategory } from '@/components/home/ShelfCategory';
import type { PackTab } from '@/lib/packs-data';

/** The shelf's title row. `href` carries the picked franchise to /slots. */
export function ShelfHeader({ href }: { href: string }) {
  return (
    <>
      <div className="flex items-baseline justify-between">
        <h2
          id="shelf-heading"
          className="font-heading text-2xl tracking-tight text-white lg:text-4xl"
        >
          Find your next pull.
        </h2>
        <Link
          href={href}
          className="flex min-h-11 items-center gap-1 text-[13px] font-semibold text-neutral-400 transition-colors hover:text-white"
        >
          All packs
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <p className="mt-1 text-sm text-neutral-400">
        Pick a pack. See the cards and odds. Make it a moment.
      </p>
    </>
  );
}

/** The home shelf's franchise switch: the server renders one ladder per
 *  category with packs (`panels`), this shows the picked one. */
export default function ShelfTabs({
  categories,
  panels,
}: {
  categories: PackTab[];
  panels: Record<string, ReactNode>;
}) {
  const { active, pick } = useShelfCategory();
  return (
    <>
      <ShelfHeader href={`/slots?category=${encodeURIComponent(active)}`} />
      {categories.length > 1 && (
        <div className="mt-4">
          <PackCategoryTabs
            categories={categories}
            active={active}
            onChange={pick}
          />
        </div>
      )}
      {panels[active]}
    </>
  );
}
