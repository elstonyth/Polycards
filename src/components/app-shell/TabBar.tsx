'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import { useCreditDot } from './CreditDotProvider';
import { useVaultDot } from './VaultDotProvider';
import { TABS, isTabActive } from './tabs';

/**
 * Bottom tab bar — the primary nav on phones (hidden lg+, where AppHeader
 * carries the same five destinations). Ink bar, hairline top edge, safe-area
 * padding; active tab is Paper White per DESIGN.md navigation spec.
 */
export default function TabBar() {
  const pathname = usePathname();
  const { customer, isLoading } = useAuth();
  const { show: vaultDot } = useVaultDot();
  const { show: creditDot } = useCreditDot();

  return (
    <nav
      data-site-chrome
      aria-label="Primary"
      className="glass-chrome fixed inset-x-0 bottom-0 z-50 border-t border-white/10 pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <div className="mx-auto flex h-16 max-w-md items-stretch">
        {TABS.map((tab) => {
          const active = isTabActive(tab, pathname);
          const Icon = tab.icon;
          // One dot per destination: the vault's arrivals, and the Me tab's
          // balance movements (its /transactions child is where they are read).
          const dot =
            (tab.href === '/vault' && vaultDot) ||
            (tab.href === '/me' && creditDot);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              // Gated tabs prompt signup in place for visitors instead of
              // navigating into the server redirect. While auth is still
              // loading, let navigation proceed (server gate covers it).
              onClick={
                tab.gated && !customer && !isLoading
                  ? (e) => {
                      e.preventDefault();
                      openAuth('signup');
                    }
                  : undefined
              }
              aria-current={active ? 'page' : undefined}
              aria-label={dot ? `${tab.label}, new items` : undefined}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-1 transition-colors',
                active
                  ? 'text-neutral-50'
                  : 'text-neutral-400 hover:text-neutral-300',
              )}
            >
              <span className="relative inline-flex">
                <Icon
                  className={cn('h-6 w-6', active && 'scale-105')}
                  strokeWidth={active ? 2.25 : 2}
                  aria-hidden
                />
                {dot && (
                  <span
                    aria-hidden
                    className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-neutral-50"
                  />
                )}
              </span>
              <span className="text-[10px] font-semibold leading-none">
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
