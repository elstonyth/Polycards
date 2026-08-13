'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { logout } from '@/lib/actions/auth';
import { reactivateAccount } from '@/lib/actions/account-lifecycle';

/**
 * Offered after a successful login when the account turns out to be
 * self-disabled. The session cookie is already set at this point — that is what
 * the reactivate call authenticates with — so declining must log out explicitly
 * rather than just closing the prompt.
 *
 * A component rather than markup inlined in AuthForm because two entry points
 * need it: the emailpass form and the Google callback. A Google-only customer
 * who self-disabled has no other way back in — the OAuth callback is not covered
 * by the login-time guard, so nothing else in that flow can tell them.
 *
 * `onDone(true)` means reactivated and the caller should continue into the
 * account; `onDone(false)` means the customer declined and is now logged out.
 */
export default function ReactivatePrompt({
  onDone,
}: {
  onDone: (reactivated: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <h3 className="font-heading text-lg font-bold text-white">
        Your account is disabled
      </h3>
      <p className="mt-2 text-[13px] text-white/60">
        You disabled this account. Reactivate it to pick up where you left off —
        your cards, balance and history are all still here.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-red-400">
          {error}
        </p>
      )}
      <div className="mt-5 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await logout();
              onDone(false);
            } catch {
              // Leaving must never dead-end. Without this the button would sit
              // spinning on an unhandled rejection and the only way out of the
              // prompt would be the modal's close button.
              setError('Could not log you out. Please try again.');
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
        >
          Not now
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await reactivateAccount();
              if (r.ok) {
                onDone(true);
                return;
              }
              setError(r.error);
            } catch {
              setError('Something went wrong. Please try again.');
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-white text-sm font-bold text-neutral-950 transition-colors hover:bg-white/90 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {busy ? 'Reactivating…' : 'Reactivate'}
        </button>
      </div>
    </div>
  );
}
