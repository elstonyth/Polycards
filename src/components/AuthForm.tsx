'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, User as UserIcon, Loader2 } from 'lucide-react';
import {
  login,
  signup,
  requestPasswordReset,
  googleLoginStart,
} from '@/lib/actions/auth';
import { useAuth } from './auth/AuthProvider';

// Inner content of the auth modal. The panel chrome (border/bg/padding) is provided
// by AuthModal; this component renders the heading, social buttons, and the form.
// `onSwitchMode` flips between login/signup in place (no navigation — the live site
// uses a single modal, not separate pages). `onSuccess` closes the modal once the
// auth server action returns a customer.

// Error notes. `field: 'password'` marks errors caused by the password pair
// (wires aria-invalid/-describedby).
type Note = { text: string; field?: 'password' };

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
    setNote({ text: result.error });
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
    setNote({ text: result.error });
  }

  async function onGoogle() {
    if (busy) return;
    setNote(null);
    setBusy(true);
    const result = await googleLoginStart();
    if (result.ok) {
      // Full-page redirect to Google's consent screen; the /auth/google/callback
      // route finishes the exchange on return. We're navigating away, so leave
      // `busy` true (no reset) to keep the button disabled until unload.
      window.location.assign(result.location);
      return;
    }
    setBusy(false);
    setNote({ text: result.error });
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
                className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-300 text-sm font-semibold text-neutral-950 shadow-[0_8px_20px_-8px_rgba(255,255,255,0.35)] transition-colors hover:to-neutral-100 disabled:opacity-70"
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
            note ? 'mt-3 text-center text-[12px] text-red-400' : 'sr-only'
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

      {/* Social — Google, wired to the backend OAuth flow. */}
      <button
        type="button"
        onClick={onGoogle}
        disabled={busy}
        className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] text-sm font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors hover:bg-white/[0.1] disabled:opacity-70"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <GoogleIcon className="h-4 w-4" />
        )}
        Continue with Google
      </button>
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
          className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-300 text-sm font-semibold text-neutral-950 shadow-[0_8px_20px_-8px_rgba(255,255,255,0.35)] transition-colors hover:to-neutral-100 disabled:opacity-70"
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
          note ? 'mt-3 text-center text-[12px] text-red-400' : 'sr-only'
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

// Official multi-color Google "G" — lucide has no brand icons.
function GoogleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29A7.19 7.19 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a11.97 11.97 0 0 0 0 10.76l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
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
        className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.05] pl-9 pr-3 text-sm text-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] placeholder:text-white/50 focus:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-0"
      />
    </div>
  );
}
