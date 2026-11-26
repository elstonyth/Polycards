import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import CategoryIcon, { isPolyIcon } from '@/components/CategoryIcon';
import type { PackTab } from '@/lib/packs-data';

/**
 * The franchise switch over a pack list (home stage and shelf, /slots, the
 * pack page): expanding tabs (owner, 2026-11-26; it was a full-width segmented
 * pill, "too bulky"). Every franchise is its icon in a slim bar; the picked
 * one opens into a grey pill with its name. A `soon` tab is dimmed, says
 * "soon" and can't be picked (packTabs). The bar is as wide as its tabs; more
 * than fit scroll sideways.
 *
 * `children` sit in the same bar after the tabs (the home stage's sorting).
 */
export default function PackCategoryTabs({
  categories,
  active,
  onChange,
  children,
}: {
  categories: PackTab[];
  active: string;
  onChange: (id: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex w-fit max-w-full items-center overflow-x-auto rounded-full border border-white/10 bg-neutral-900 p-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] [-ms-overflow-style:none] [scrollbar-width:none] empty:hidden [&::-webkit-scrollbar]:hidden">
      {categories.length > 1 && (
        <div
          role="group"
          aria-label="Pack categories"
          className="flex items-center gap-0.5"
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
                  'relative flex h-9 shrink-0 items-center rounded-full px-2 text-sm font-semibold whitespace-nowrap transition-colors duration-200 motion-reduce:transition-none',
                  // 36 px tall: the tap target reaches the bar's edges (44 px).
                  "before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']",
                  'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                  on
                    ? 'bg-neutral-700 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]'
                    : c.soon
                      ? 'cursor-not-allowed text-neutral-500'
                      : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white',
                )}
              >
                <CategoryIcon
                  src={c.icon}
                  size={20}
                  className={cn(
                    'h-5 w-5 shrink-0',
                    c.soon && 'opacity-50 grayscale-[0.4]',
                    // Our mark takes the text colour: idle grey would read as
                    // "soon" beside the full-colour franchise icons.
                    isPolyIcon(c.icon) && !on && !c.soon && 'text-white',
                  )}
                />
                {c.soon ? (
                  <>
                    <span className="sr-only">{c.tab}</span>
                    {/* The narrowest phones keep only the dimmed icon. */}
                    <span className="pr-1 pl-1.5 text-[10px] font-medium tracking-wide uppercase max-[359px]:sr-only">
                      <span className="sr-only">Coming </span>soon
                    </span>
                  </>
                ) : (
                  // The name unfolds: a grid column from 0fr to 1fr animates
                  // to the text's own width.
                  <span
                    className={cn(
                      'grid transition-[grid-template-columns,opacity] duration-300 ease-(--ease-out-quart) motion-reduce:transition-none',
                      on
                        ? 'grid-cols-[1fr] opacity-100'
                        : 'grid-cols-[0fr] opacity-0',
                    )}
                  >
                    <span className="min-w-0 overflow-hidden">
                      <span className="block px-1.5">{c.tab}</span>
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {children}
    </div>
  );
}
