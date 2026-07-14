'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, User as UserIcon, Loader2 } from 'lucide-react';
import { login, signup, requestPasswordReset } from '@/lib/actions/auth';
import { useAuth } from './auth/AuthProvider';

// Inner content of the auth modal. The panel chrome (border/bg/padding) is provided
// by AuthModal; this component renders the heading, social buttons, and the form.
// `onSwitchMode` flips between login/signup in place (no navigation — the live site
// uses a single modal, not separate pages). `onSuccess` closes the modal once the
// auth server action returns a customer.

// Errors and informational notes share one slot but render differently:
// errors get role="alert" + red, notes stay quiet grey. `field: 'password'`
// marks errors caused by the password pair (wires aria-invalid/-describedby).
type Note = { kind: 'error' | 'info'; text: string; field?: 'password' };

export default function AuthForm({
  mode,
  onSwitchMode,
  onSuccess,
}: {
  mode: 'login' | 'signup';
  onSwitchMode: (m: 'login' | 'signup') => void;
  onSuccess?: () => void;
}) {
  const isSignup = mode === 'signup';
  const router = useRouter();
  const { setCustomer } = useAuth();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // Forgot-password lives inside the login mode as a sub-view (the live site
  // keeps everything in the one modal): "form" collects the email, "sent" is
  // the always-the-same confirmation (no account enumeration — the backend
  // 201s for unknown emails too).
  const [forgot, setForgot] = useState<'none' | 'form' | 'sent'>('none');

  function switchMode(m: 'login' | 'signup') {
    setForgot('none');
    setNote(null);
    onSwitchMode(m);
  }

  async function onForgotSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setNote(null);

    const email = String(new FormData(e.currentTarget).get('email') ?? '');
    setBusy(true);
    const result = await requestPasswordReset({ email });
    setBusy(false);

    if (result.ok) {
      setForgot('sent');
      return;
    }
    setNote({ kind: 'error', text: result.error });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setNote(null);

    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');

    if (isSignup && password !== String(form.get('confirmPassword') ?? '')) {
      setNote({
        kind: 'error',
        text: "Passwords don't match.",
        field: 'password',
      });
      return;
    }

    setBusy(true);
    const result = isSignup
      ? await signup({
          email,
          password,
          first_name: String(form.get('username') ?? ''),
        })
      : await login({ email, password });
    setBusy(false);

    if (result.ok) {
      // The action returns the customer — update context directly (no refetch flash).
      setCustomer(result.customer);
      onSuccess?.();
      router.refresh();
      return;
    }
    setNote({ kind: 'error', text: result.error });
  }

  // Only the login mode owns the forgot sub-view — if something external
  // flips the modal to signup (openAuth event) the signup form must win.
  if (!isSignup && forgot !== 'none') {
    return (
      <div className="w-full">
        <h2 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Reset your password
        </h2>
        {forgot === 'form' ? (
          <>
            <p className="mt-1.5 text-sm text-white/50">
              Enter your email and we&apos;ll send you a reset link.
            </p>
            <form
              onSubmit={onForgotSubmit}
              className="mt-6 flex flex-col gap-3"
            >
              <Field
                icon={Mail}
                name="email"
                type="email"
                placeholder="Email"
                autoComplete="email"
                required
              />
              <button
                type="submit"
                disabled={busy}
                className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-neutral-200 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white disabled:opacity-70"
              >
                {busy && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                )}
                Send reset link
              </button>
            </form>
          </>
        ) : (
          // Same copy whether or not the account exists — the backend
          // responds identically, and so does this view.
          <p className="mt-1.5 text-sm text-white/50">
            If an account exists for that email, a reset link is on its way.
            Check your inbox.
          </p>
        )}

        {/* Persistent live region: an alert node inserted already-populated may
            not be announced; keeping it mounted (sr-only while empty) and only
            swapping its text is announced reliably. */}
        <p
          aria-live="assertive"
          aria-atomic="true"
          className={
            note
              ? `mt-3 text-center text-[12px] ${
                  note.kind === 'error' ? 'text-red-400' : 'text-white/50'
                }`
              : 'sr-only'
          }
        >
          {note?.text}
        </p>

        <p className="mt-6 text-center text-[13px] text-white/50">
          Remembered it?{' '}
          <button
            type="button"
            onClick={() => {
              setForgot('none');
              setNote(null);
            }}
            className="font-semibold text-white hover:underline"
          >
            Back to log in
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="w-full">
      <h2 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
        {isSignup ? 'Create your account' : 'Welcome back'}
      </h2>
      <p className="mt-1.5 text-sm text-white/50">
        {isSignup
          ? 'Start ripping packs and collecting graded cards.'
          : 'Log in to your Polycards account.'}
      </p>

      {/* Social */}
      <div className="mt-6 grid grid-cols-2 gap-3">
        {['Google', 'Discord'].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() =>
              setNote({
                kind: 'info',
                text: 'Social login goes live with the backend.',
              })
            }
            className="flex h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] text-sm font-medium text-white transition-colors hover:bg-white/[0.08]"
          >
            {p}
          </button>
        ))}
      </div>
      <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wide text-white/50">
        <span className="h-px flex-1 bg-white/10" /> or{' '}
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        {isSignup && (
          <Field
            icon={UserIcon}
            name="username"
            type="text"
            placeholder="Username"
            // Submitted as first_name (a display name), not a login identifier.
            autoComplete="nickname"
          />
        )}
        <Field
          icon={Mail}
          name="email"
          type="email"
          placeholder="Email"
          autoComplete="email"
          required
        />
        <Field
          icon={Lock}
          name="password"
          type="password"
          placeholder="Password"
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          required
          minLength={isSignup ? 8 : undefined}
          aria-invalid={note?.field === 'password' || undefined}
          aria-describedby={
            note?.field === 'password' ? 'auth-form-error' : undefined
          }
        />
        {isSignup && (
          <Field
            icon={Lock}
            name="confirmPassword"
            type="password"
            placeholder="Confirm password"
            autoComplete="new-password"
            required
            aria-invalid={note?.field === 'password' || undefined}
            aria-describedby={
              note?.field === 'password' ? 'auth-form-error' : undefined
            }
          />
        )}

        {!isSignup && (
          <button
            type="button"
            onClick={() => {
              setForgot('form');
              setNote(null);
            }}
            className="self-end py-2 text-[12px] text-white/70 hover:text-white"
          >
            Forgot password?
          </button>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-neutral-200 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white disabled:opacity-70"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {isSignup ? 'Create account' : 'Log in'}
        </button>
      </form>

      {/* Persistent live region (see forgot-password note above); keeps the
          aria-describedby target mounted too. */}
      <p
        id="auth-form-error"
        aria-live="assertive"
        aria-atomic="true"
        className={
          note
            ? `mt-3 text-center text-[12px] ${
                note.kind === 'error' ? 'text-red-400' : 'text-white/50'
              }`
            : 'sr-only'
        }
      >
        {note?.text}
      </p>

      <p className="mt-6 text-center text-[13px] text-white/50">
        {isSignup ? 'Already have an account? ' : 'New to Polycards? '}
        <button
          type="button"
          onClick={() => switchMode(isSignup ? 'login' : 'signup')}
          className="font-semibold text-white hover:underline"
        >
          {isSignup ? 'Log in' : 'Sign up'}
        </button>
      </p>
    </div>
  );
}

function Field({
  icon: Icon,
  ...props
}: { icon: typeof Mail } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <Icon
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35"
        aria-hidden
      />
      <input
        aria-label={props['aria-label'] ?? props.placeholder}
        {...props}
        className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-3 text-sm text-white placeholder:text-white/50 focus:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-0"
      />
    </div>
  );
}
