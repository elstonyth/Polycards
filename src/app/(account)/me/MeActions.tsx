'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Plus } from 'lucide-react';
import { logout } from '@/lib/actions/auth';
import { cn } from '@/lib/utils';
import { useAuth } from '@/components/auth/AuthProvider';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { Pill } from '@/components/ui/pill';

/** TopUpButton in the glacier look: the money screens' one main action.
 *  shortcut: lives here because TopUpButton (shared) has no variant prop; move it there when one lands. */
export function GlacierTopUpButton({ className }: { className?: string }) {
  const { openTopUp } = useTopUp();
  return (
    <Pill variant="glacier" onClick={openTopUp} className={className}>
      <Plus className="h-4 w-4" strokeWidth={3} aria-hidden />
      Top Up
    </Pill>
  );
}

export function LogoutButton({
  className,
  icon,
}: {
  className?: string;
  /** Its own icon (the Me screen's shortcut tile); the words stay this button's. */
  icon?: ReactNode;
} = {}) {
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
      aria-busy={busy}
      className={cn(
        'flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 text-sm font-semibold text-neutral-400 transition-colors hover:text-white disabled:opacity-50',
        className,
      )}
    >
      {icon ?? <LogOut className="h-4 w-4" aria-hidden />}
      {busy ? 'Logging out…' : 'Log out'}
    </button>
  );
}
