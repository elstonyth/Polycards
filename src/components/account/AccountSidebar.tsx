'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Settings,
  Package,
  Receipt,
  Gift,
  Ticket,
  Landmark,
  Vault,
  Wallet as WalletIcon,
  Crown,
  Bell,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export const ACCOUNT_NAV: { label: string; href: string; icon: LucideIcon }[] =
  [
    { label: 'VIP', href: '/vip', icon: Crown },
    { label: 'Rewards', href: '/rewards', icon: Sparkles },
    { label: 'Vault', href: '/vault', icon: Vault },
    { label: 'Wallet', href: '/wallet', icon: WalletIcon },
    { label: 'Settings', href: '/settings', icon: Settings },
    { label: 'Orders', href: '/orders', icon: Package },
    { label: 'Transactions', href: '/transactions', icon: Receipt },
    { label: 'Referrals', href: '/referrals', icon: Gift },
    { label: 'Vouchers', href: '/vouchers', icon: Ticket },
    { label: 'Withdraw', href: '/bank-withdrawal', icon: Landmark },
    { label: 'Notifications', href: '/notifications', icon: Bell },
  ];

export default function AccountSidebar() {
  const path = usePathname();
  return (
    <aside className="shrink-0 lg:w-60">
      {/* horizontal scroll on mobile, sticky column on desktop */}
      <nav className="flex gap-1 overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03] p-2 lg:sticky lg:top-20 lg:flex-col lg:overflow-visible [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {ACCOUNT_NAV.map((item) => {
          const Icon = item.icon;
          const active = path === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition-colors',
                active
                  ? 'bg-white/10 text-white'
                  : 'text-white/55 hover:bg-white/5 hover:text-white',
              )}
            >
              <Icon className="h-4 w-4 shrink-0 text-white/50" aria-hidden />
              <span className="whitespace-nowrap">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
