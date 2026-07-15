'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Plus } from 'lucide-react';
import { logout } from '@/lib/actions/auth';
import { useAuth } from '@/components/auth/AuthProvider';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { Pill } from '@/components/ui/pill';

export function TopUpButton({
  className = 'flex-1',
  size,
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const { openTopUp } = useTopUp();
  return (
    <Pill onClick={openTopUp} size={size} className={className}>
      <Plus className="h-4 w-4" strokeWidth={3} aria-hidden />
      Top Up
    </Pill>
  );
}

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { setCustomer } = useAuth();

  async function handleLogout() {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
      setCustomer(null);
      router.push('/');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={busy}
      className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 text-sm font-semibold text-neutral-400 transition-colors hover:text-white disabled:opacity-50"
    >
      <LogOut className="h-4 w-4" aria-hidden />
      {busy ? 'Logging out…' : 'Log out'}
    </button>
  );
}
