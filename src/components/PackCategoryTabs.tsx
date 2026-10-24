import Image from 'next/image';
import { cn } from '@/lib/utils';
import type { PackCategory } from '@/lib/packs-data';

/**
 * The franchise switch over a pack list (home shelf, /slots): the leaderboard's
 * segmented pill (DESIGN.md "Tier tabs", selected = Paper White on Ink), sized
 * up because the franchise is the first choice a player makes. A few tabs
 * stretch to share the row; more than fit scroll sideways. Only categories that
 * have packs are passed in, and callers drop the switch while there is one.
 */
export default function PackCategoryTabs({
  categories,
  active,
  onChange,
}: {
  categories: Pick<PackCategory, 'id' | 'tab' | 'icon'>[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Pack categories"
      className="flex gap-1 overflow-x-auto rounded-full border border-white/10 bg-neutral-900 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {categories.map((c) => {
        const on = c.id === active;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            aria-pressed={on}
            className={cn(
              'flex min-h-12 flex-1 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full px-5 text-sm font-semibold transition-colors lg:min-h-14 lg:text-base',
              'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
              on
                ? 'bg-neutral-50 text-neutral-950'
                : 'text-neutral-400 hover:text-white',
            )}
          >
            <Image
              src={c.icon}
              alt=""
              aria-hidden="true"
              width={28}
              height={28}
              className="h-6 w-6 shrink-0 object-contain lg:h-7 lg:w-7"
            />
            {c.tab}
          </button>
        );
      })}
    </div>
  );
}
