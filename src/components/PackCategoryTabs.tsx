import Image from 'next/image';
import { cn } from '@/lib/utils';
import type { PackTab } from '@/lib/packs-data';

/**
 * The franchise switch over a pack list (home shelf, /slots): the leaderboard's
 * segmented pill (DESIGN.md "Tier tabs", selected = Paper White on Ink), sized
 * up because the franchise is the first choice a player makes. A few tabs
 * stretch to share the row; more than fit scroll sideways. A `soon` tab shows
 * "Coming soon" and can't be picked (packTabs).
 */
export default function PackCategoryTabs({
  categories,
  active,
  onChange,
}: {
  categories: PackTab[];
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
            disabled={c.soon}
            onClick={() => onChange(c.id)}
            aria-pressed={on}
            className={cn(
              'flex min-h-12 flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2 text-sm font-semibold transition-colors sm:gap-2 sm:px-5 lg:min-h-14 lg:text-base',
              'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
              on
                ? 'bg-neutral-50 text-neutral-950'
                : c.soon
                  ? 'cursor-not-allowed text-neutral-500'
                  : 'text-neutral-400 hover:text-white',
            )}
          >
            <Image
              src={c.icon}
              alt=""
              aria-hidden="true"
              width={28}
              height={28}
              className={cn(
                'h-5 w-5 shrink-0 object-contain sm:h-6 sm:w-6 lg:h-7 lg:w-7',
                // The narrowest phones can't fit three icons and "Coming soon".
                c.soon && 'hidden opacity-50 grayscale-[0.4] min-[360px]:block',
              )}
            />
            {c.soon ? (
              <span className="flex flex-col items-start leading-tight">
                {c.tab}
                <span className="text-[10px] font-medium lg:text-[11px]">
                  Coming soon
                </span>
              </span>
            ) : (
              c.tab
            )}
          </button>
        );
      })}
    </div>
  );
}
