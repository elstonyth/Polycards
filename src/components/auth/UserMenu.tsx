'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, LogOut, Package, Settings, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { logout, type AuthCustomer } from '@/lib/actions/auth';
import { useAuth } from './AuthProvider';

const MENU_LINKS = [
  { label: 'Orders', href: '/orders', icon: Package },
  { label: 'Settings', href: '/settings', icon: Settings },
] as const;

// "My Profile" goes first when the customer's public handle is known (it is
// lazily assigned by the backend, so a just-failed fetch simply hides the link
// until the next /api/me refresh).
const menuLinks = (handle: string | null) =>
  handle
    ? [
        { label: 'My Profile', href: `/profile/${handle}`, icon: User },
        ...MENU_LINKS,
      ]
    : [...MENU_LINKS];

const displayName = (c: AuthCustomer) =>
  c.first_name?.trim() || c.email.split('@')[0] || c.email;

/** Logged-in header control: avatar + dropdown (account links + logout). */
export default function UserMenu({ customer }: { customer: AuthCustomer }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { setCustomer } = useAuth();

  const name = displayName(customer);
  const initial = (name[0] ?? '?').toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function onLogout() {
    setOpen(false);
    await logout();
    setCustomer(null);
    router.push('/');
    router.refresh();
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        className="flex h-10 items-center gap-2 rounded-lg bg-white/5 py-1 pl-1.5 pr-2.5 text-sm font-medium text-white transition-colors hover:bg-white/10"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-700 text-[12px] font-bold text-white">
          {initial}
        </span>
        <span className="hidden max-w-[120px] truncate sm:block">{name}</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-white/50 transition-transform duration-200',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[220px] overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 p-1 shadow-xl shadow-black/40"
        >
          <div className="border-b border-neutral-800 px-3 py-2.5">
            <p className="truncate text-sm font-medium text-white">{name}</p>
            <p className="truncate text-[12px] text-white/50">
              {customer.email}
            </p>
          </div>
          {menuLinks(customer.handle).map(({ label, href, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="mt-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-neutral-200 transition-colors hover:bg-white/5 hover:text-white"
            >
              <Icon className="h-4 w-4 text-neutral-400" aria-hidden />
              {label}
            </Link>
          ))}
          <button
            type="button"
            onClick={onLogout}
            role="menuitem"
            className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-neutral-200 transition-colors hover:bg-white/5 hover:text-white"
          >
            <LogOut className="h-4 w-4 text-neutral-400" aria-hidden />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
