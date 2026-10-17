'use client';

import { useId } from 'react';
import { CountryFlag } from '@/components/ui/country-flag';
import type { BankCountryGroup } from '@/lib/regional-rails';
import { cn } from '@/lib/utils';

/**
 * Which country's banks a bank picker lists: one flagged pill per country,
 * the leaderboard's segmented toggle (aria-pressed buttons, not ARIA tabs —
 * the select below is the only panel). Nothing renders with one country to
 * offer, e.g. while the Singapore rail is closed.
 */
export function BankCountryToggle({
  groups,
  value,
  onChange,
  className,
}: {
  groups: readonly Omit<BankCountryGroup<unknown>, 'items'>[];
  value: string;
  onChange: (country: string) => void;
  className?: string;
}) {
  const labelId = useId();
  if (groups.length < 2) return null;
  return (
    <div className={className}>
      <p id={labelId} className="text-[13px] font-semibold text-neutral-300">
        Bank country
      </p>
      <div
        role="group"
        aria-labelledby={labelId}
        className="mt-1.5 grid auto-cols-fr grid-flow-col gap-1 rounded-full border border-white/10 bg-neutral-900 p-1"
      >
        {groups.map((group) => (
          <button
            key={group.country}
            type="button"
            aria-pressed={value === group.country}
            onClick={() => onChange(group.country)}
            className={cn(
              'flex min-h-10 items-center justify-center gap-2 rounded-full px-3 text-sm font-semibold transition-colors',
              'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
              value === group.country
                ? 'bg-neutral-50 text-neutral-950'
                : 'text-neutral-400 hover:text-white',
            )}
          >
            {group.flag && (
              <CountryFlag
                country={group.flag}
                // The white-on-white edge of Singapore's flag needs a dark
                // hairline on the selected (white) pill.
                className={cn(
                  'h-3.5 w-[21px]',
                  value === group.country && 'ring-neutral-950/20',
                )}
              />
            )}
            {group.country}
          </button>
        ))}
      </div>
    </div>
  );
}
