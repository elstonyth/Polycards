'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IdCard } from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';
import { RealNameEntry } from '@/components/account/RealNameEntry';
import { logout } from '@/lib/actions/auth';
import { useModalA11y } from '@/lib/use-modal-a11y';

// Escape is deliberately inert: the gate has no dismiss (see below).
const noop = () => {};

/**
 * The real-name gate (spec 2026-10-06): every account without a real name on
 * file — new Google signups, an emailpass signup whose post-signup save
 * failed, and every account registered before this shipped — meets this over
 * the account pages until it enters one. Same shell and same rules as
 * PhoneOnboardingModal: no Skip, Escape does nothing, Log out is the only
 * other exit. The layout never mounts both at once; the phone gate goes first.
 *
 * UX only: the welcome-pack claim refuses an account without a real name at
 * the backend whatever this modal does.
 */
export function RealNameModal() {
  const router = useRouter();
  const { setCustomer } = useAuth();
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hides the gate for the beat between the save and router.refresh()
  // re-rendering the layout without it.
  const [done, setDone] = useState(false);

  useModalA11y(panelRef, !done, noop);

  // Same sequence as PhoneOnboardingModal's exit.
  async function onLogout() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await logout();
      setCustomer(null);
      router.push('/');
      router.refresh();
    } catch {
      setError('Could not log you out. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) return null;

  return (
    // z-[60]: above the app header and TabBar (both z-50), like the phone gate.
    <div className="glass-stage fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="real-name-title"
        tabIndex={-1}
        className="glass-panel max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border p-6 outline-none sm:p-7"
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
          <IdCard className="h-5 w-5 text-white" aria-hidden />
        </span>
        <h2
          id="real-name-title"
          className="font-heading mt-4 text-2xl text-white"
        >
          Add your real name
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          We use your real name for verification — to confirm prize winners and
          keep accounts one-per-person. It stays private — your username is what
          other players see.
        </p>

        <div className="mt-5">
          <RealNameEntry
            onSaved={() => {
              setDone(true);
              router.refresh();
            }}
          />
        </div>

        {error && (
          <p role="alert" className="mt-3 text-[12px] text-red-400">
            {error}
          </p>
        )}
        <p className="mt-5 text-center text-[12px] text-neutral-400">
          Not now?{' '}
          <button
            type="button"
            onClick={onLogout}
            disabled={busy}
            className="min-h-11 font-semibold text-white underline-offset-2 hover:underline disabled:opacity-50"
          >
            Log out
          </button>
        </p>
      </div>
    </div>
  );
}
