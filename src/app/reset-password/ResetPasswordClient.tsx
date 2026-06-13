'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Lock, Loader2, CheckCircle2 } from 'lucide-react';
import { resetPassword } from '@/lib/actions/auth';

// Landing page for the emailed reset link:
// /reset-password?token=…&email=…  (built by the backend's password-reset
// subscriber). The token is the credential — the email is only shown so the
// user knows which account they're resetting. On success we bounce to
// /?auth=login, which auto-opens the login modal (see AuthModal).

export default function ResetPasswordClient() {
  const router = useRouter();
  const params = useSearchParams();
  // Capture once, then scrub the query from the address bar — an abandoned
  // (unused) link in a shared computer's history stays valid for up to 15m.
  const [token] = useState(() => params.get('token') ?? '');
  const [email] = useState(() => params.get('email') ?? '');
  useEffect(() => {
    if (!window.location.search) return;
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // AuthModal's ?auth=login auto-open only fires on a fresh page load (its
  // effect runs once on mount, and the modal stays mounted across client
  // navigations) — so open it via its event and navigate home. The modal is
  // global (SiteHeader), so it survives the route change.
  function goToLogin() {
    window.dispatchEvent(
      new CustomEvent('pokenic:auth', { detail: { mode: 'login' } }),
    );
    router.replace('/');
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setNote(null);

    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirmPassword') ?? '')) {
      setNote("Passwords don't match.");
      return;
    }

    setBusy(true);
    const result = await resetPassword({ token, password });
    setBusy(false);

    if (result.ok) {
      setDone(true);
      goToLogin();
      return;
    }
    setNote(result.error);
  }

  return (
    <main className="px-fluid flex min-h-[70vh] items-center justify-center py-16">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-neutral-950 p-7 sm:p-8">
        {!token ? (
          <>
            <h1 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Invalid reset link
            </h1>
            <p className="mt-1.5 text-sm text-white/50">
              This link is missing its reset token. Request a new one from the
              login screen.
            </p>
            <button
              type="button"
              onClick={goToLogin}
              className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-xl bg-neutral-200 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
            >
              Back to log in
            </button>
          </>
        ) : done ? (
          <>
            <h1 className="flex items-center gap-2 font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
              <CheckCircle2 className="h-6 w-6 text-emerald-400" aria-hidden />
              Password updated
            </h1>
            <p className="mt-1.5 text-sm text-white/50">
              Taking you to the login…
            </p>
          </>
        ) : (
          <>
            <h1 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Choose a new password
            </h1>
            <p className="mt-1.5 text-sm text-white/50">
              {email ? (
                <>
                  Set a new password for{' '}
                  <span className="text-white/80">{email}</span>.
                </>
              ) : (
                'Set a new password for your account.'
              )}
            </p>

            <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
              <div className="relative">
                <Lock
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35"
                  aria-hidden
                />
                <input
                  name="password"
                  type="password"
                  placeholder="New password"
                  aria-label="New password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-3 text-sm text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none"
                />
              </div>
              <div className="relative">
                <Lock
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35"
                  aria-hidden
                />
                <input
                  name="confirmPassword"
                  type="password"
                  placeholder="Confirm new password"
                  aria-label="Confirm new password"
                  autoComplete="new-password"
                  required
                  className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-3 text-sm text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-neutral-200 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white disabled:opacity-70"
              >
                {busy && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                )}
                Update password
              </button>
            </form>

            {note && (
              <p className="mt-3 text-center text-[12px] text-white/45">
                {note}
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
