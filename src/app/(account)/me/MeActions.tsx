'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { logout } from '@/lib/actions/auth';
import { useAuth } from '@/components/auth/AuthProvider';

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
