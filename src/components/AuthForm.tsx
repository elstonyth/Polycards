'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, User as UserIcon, Loader2 } from 'lucide-react';
import {
  login,
  signup,
  requestPasswordReset,
  googleLoginStart,
  type AuthResult,
} from '@/lib/actions/auth';
import { leaveFor } from '@/lib/navigation';
import { useAuth } from './auth/AuthProvider';
import { NAME_MAX, normalizePhone } from '@/lib/profile-validation';
import { PhoneField } from '@/components/PhoneField';
import { PhoneOtpStep } from '@/components/auth/PhoneOtpStep';
import {
  startPhoneOtp,
  resetPasswordByPhone,
} from '@/lib/actions/phone-verification';
import { PHONE_VERIFICATION_REQUIRED } from '@/lib/phone-verification';

// The Field inputs below carry a pl-9 for their leading icon; PhoneField has
// no icon, so it gets the same chrome with plain px-3.
const PHONE_INPUT_CLASS =
  'h-11 w-full rounded-xl border border-white/10 bg-white/[0.05] px-3 text-sm text-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] placeholder:text-white/50 focus:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-0';

// Inner content of the auth modal. The panel chrome (border/bg/padding) is provided
// by AuthModal; this component renders the heading, social buttons, and the form.
// `onSwitchMode` flips between login/signup in place (no navigation — the live site
// uses a single modal, not separate pages). `onSuccess` closes the modal once the
// auth server action returns a customer.

// Error notes. `field` marks which input caused the error (wires
// aria-invalid/-describedby): the password pair or the signup phone.
type Note = { text: string; field?: 'password' | 'phone' };

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
  const [forgot, setForgot] = useState<
    'none' | 'form' | 'sent' | 'phone' | 'phone-otp'
  >('none');
  // Phone entered on the 'phone' sub-view, carried into 'phone-otp'.
  const [forgotPhone, setForgotPhone] = useState('');
  // Signup-only sub-view: once the phone OTP is sent, hold the rest of the
  // form's values here so `onVerified` can finish the real signup() call.
  const [otp, setOtp] = useState<{
    phone: string;
    pending: { email: string; password: string; first_name: string };
  } | null>(null);
  // Snapshot of the signup form's values, taken the moment the OTP step is
  // entered. Unlike `otp`, this SURVIVES `setOtp(null)` (Back, or a
  // signup() failure after a real SMS was already sent) — the remounted
  // signup form below reads it to re-seed its uncontrolled inputs via
  // `defaultValue` instead of rendering empty. Only ever set from the
  // PHONE_VERIFICATION_REQUIRED branch of onSubmit, so it stays null (no
  // behavior change) on the flag-off path.
  const [signupDraft, setSignupDraft] = useState<{
    email: string;
    password: string;
    first_name: string;
    phone: string;
    // A still-valid proof token from a signup() that failed AFTER the OTP
    // passed (e.g. duplicate email). Reused on the next submit for the SAME
    // phone so the user isn't texted (and billed) twice; cleared when the
    // backend rejects it or the phone changes.
    proofToken: string | null;
  } | null>(null);

  function switchMode(m: 'login' | 'signup') {
    setForgot('none');
    setNote(null);
    setOtp(null);
    setSignupDraft(null);
    onSwitchMode(m);
  }

  async function onForgotSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setNote(null);

    const email = String(new FormData(e.currentTarget).get('email') ?? '');
    setBusy(true);
    try {
      const result = await requestPasswordReset({ email });
      if (result.ok) {
        setForgot('sent');
        return;
      }
      setNote({ text: result.error });
    } catch {
      setNote({ text: 'Something went wrong. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function onForgotPhoneSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setNote(null);

    // Same normalization the server applies — catch a bad number before the
    // round-trip (see onSubmit's signup-phone comment).
    const phone = normalizePhone(
      String(new FormData(e.currentTarget).get('phone') ?? ''),
    );
    if (!phone) {
      setNote({
        text: 'Please enter a valid phone number for the selected country.',
      });
      return;
    }

    setBusy(true);
    try {
      const result = await startPhoneOtp({ phone, purpose: 'password-reset' });
      if (!result.ok) {
        setNote({ text: result.error });
        return;
      }
      setForgotPhone(phone);
      setForgot('phone-otp');
    } catch {
      setNote({ text: 'Something went wrong. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  // Shared tail for both login and signup — the action returns the customer,
  // so update context directly (no refetch flash) on success.
  function finishAuth(result: AuthResult) {
    if (result.ok) {
      setCustomer(result.customer);
      onSuccess?.();
      router.refresh();
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

    if (!isSignup) {
      setBusy(true);
      try {
        const result = await login({ email, password });
        finishAuth(result);
      } catch {
        setNote({ text: 'Something went wrong. Please try again.' });
      } finally {
        setBusy(false);
      }
      return;
    }

    // Same normalization the server applies — catch a bad number before the
    // round-trip (the action re-validates; a server action is a public endpoint).
    // PhoneField submits E.164 (+<country code><number>) in the hidden input.
    const phone = normalizePhone(String(form.get('phone') ?? ''));
    if (!phone) {
      setNote({
        text: 'Please enter a valid phone number for the selected country.',
        field: 'phone',
      });
      return;
    }
    const first_name = String(form.get('username') ?? '');

    if (PHONE_VERIFICATION_REQUIRED) {
      setBusy(true);
      try {
        // A proof token from a failed post-OTP signup() stays valid for ~10
        // minutes for the SAME phone — reuse it instead of sending (and
        // paying for) another SMS. Only when the backend rejects the token
        // (expired) does the flow fall through to a fresh OTP send.
        if (signupDraft?.proofToken && signupDraft.phone === phone) {
          const retry = await signup({
            email,
            password,
            first_name,
            phone,
            phone_verification_token: signupDraft.proofToken,
          });
          if (retry.ok || !/verif/i.test(retry.error)) {
            // Keep the token for another retry (e.g. a second duplicate
            // email) and refresh the draft to what was just typed.
            setSignupDraft({
              email,
              password,
              first_name,
              phone,
              proofToken: signupDraft.proofToken,
            });
            finishAuth(retry);
            return;
          }
          // Verification-shaped rejection — token expired/consumed. Clear it
          // and fall through to a fresh OTP.
          setSignupDraft({ ...signupDraft, proofToken: null });
        }
        const otpResult = await startPhoneOtp({ phone, purpose: 'signup' });
        if (!otpResult.ok) {
          setNote({ text: otpResult.error });
          return;
        }
        // Defer the real signup() call until the code is verified — pending
        // fields ride along in state for onVerified to use. signupDraft is
        // the same values, but kept around after setOtp(null) (see its
        // comment).
        setOtp({ phone, pending: { email, password, first_name } });
        setSignupDraft({
          email,
          password,
          first_name,
          phone,
          proofToken: null,
        });
      } catch {
        setNote({ text: 'Something went wrong. Please try again.' });
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const result = await signup({ email, password, first_name, phone });
      finishAuth(result);
    } catch {
      setNote({ text: 'Something went wrong. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    if (busy) return;
    setNote(null);
    setBusy(true);
    // No `finally` here, deliberately: on success we navigate away and must
    // leave `busy` true (see comment below) — a finally would re-enable the
    // button mid-redirect. Both the !ok branch and the catch reset it.
    try {
      const result = await googleLoginStart();
      if (result.ok) {
        // Full-page redirect to Google's consent screen; the /auth/google/callback
        // route finishes the exchange on return. We're navigating away, so leave
        // `busy` true (no reset) to keep the button disabled until unload.
        leaveFor(result.location);
        return;
      }
      setBusy(false);
      setNote({ text: result.error });
    } catch {
      setBusy(false);
      setNote({ text: 'Something went wrong. Please try again.' });
    }
  }

  // Only the login mode owns the forgot sub-view — if something external
  // flips the modal to signup (openAuth event) the signup form must win.
  if (!isSignup && forgot !== 'none') {
    return (
      <div className="w-full">
        <h2 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Reset your password
        </h2>
        {forgot === 'form' && (
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
              {PHONE_VERIFICATION_REQUIRED && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setForgot('phone');
                    setNote(null);
                  }}
                  className="self-center py-2 text-[12px] text-white/70 hover:text-white disabled:opacity-70"
                >
                  Use phone number instead
                </button>
              )}
            </form>
          </>
        )}

        {forgot === 'sent' && (
          // Same copy whether or not the account exists — the backend
          // responds identically, and so does this view.
          <p className="mt-1.5 text-sm text-white/50">
            If an account exists for that email, a reset link is on its way.
            Check your inbox.
          </p>
        )}

        {forgot === 'phone' && (
          <>
            <p className="mt-1.5 text-sm text-white/50">
              Enter the phone number on your account.
            </p>
            <form
              onSubmit={onForgotPhoneSubmit}
              className="mt-6 flex flex-col gap-3"
            >
              <PhoneField
                name="phone"
                defaultValue={forgotPhone}
                inputClassName={PHONE_INPUT_CLASS}
                placeholder="Phone number"
                required
              />
              <p className="text-[12px] text-white/50">
                If an account uses this number, we&apos;ll text a code.
              </p>
              <button
                type="submit"
                disabled={busy}
                className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-300 text-sm font-semibold text-neutral-950 shadow-[0_8px_20px_-8px_rgba(255,255,255,0.35)] transition-colors hover:to-neutral-100 disabled:opacity-70"
              >
                {busy && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                )}
                Send code
              </button>
            </form>
          </>
        )}

        {forgot === 'phone-otp' && (
          <PhoneOtpStep
            phone={forgotPhone}
            purpose="password-reset"
            onBack={() => setForgot('phone')}
            onVerified={async (proofToken) => {
              const result = await resetPasswordByPhone({
                token: proofToken,
              });
              if (result.ok) {
                // Full-page load on purpose: AuthForm only ever renders
                // inside AuthModal, so a client-side push would navigate the
                // page behind a still-mounted overlay.
                leaveFor(
                  `/reset-password?token=${encodeURIComponent(result.token)}&email=${encodeURIComponent(result.maskedEmail)}`,
                );
                return;
              }
              setForgot('phone');
              setNote({ text: result.error });
            }}
          />
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

  // Signup phone-OTP sub-view (only reachable when PHONE_VERIFICATION_REQUIRED
  // sent us here from onSubmit). Not wrapped in `isSignup` alone — `otp` only
  // ever gets set on the signup branch, but the guard makes the invariant
  // explicit and mirrors the forgot-password guard above.
  if (isSignup && otp) {
    return (
      <div className="w-full">
        <h2 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Verify your phone
        </h2>
        <PhoneOtpStep
          phone={otp.phone}
          purpose="signup"
          onBack={() => setOtp(null)}
          onVerified={async (token) => {
            const result = await signup({
              ...otp.pending,
              phone: otp.phone,
              phone_verification_token: token,
            });
            // On failure, fall back to the signup form — signupDraft (still
            // set) re-seeds it instead of it rendering empty, and it KEEPS
            // this proof token so the next submit for the same phone skips a
            // second paid SMS (see onSubmit). finishAuth handles both
            // branches: setCustomer/onSuccess/refresh on ok, setNote on
            // failure.
            if (!result.ok) {
              setSignupDraft((d) => (d ? { ...d, proofToken: token } : d));
              setOtp(null);
            }
            finishAuth(result);
          }}
        />
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
            maxLength={NAME_MAX}
            defaultValue={signupDraft?.first_name}
          />
        )}
        <Field
          icon={Mail}
          name="email"
          type="email"
          placeholder="Email"
          autoComplete="email"
          required
          defaultValue={signupDraft?.email}
        />
        {isSignup && (
          <PhoneField
            name="phone"
            defaultValue={signupDraft?.phone ?? ''}
            inputClassName={PHONE_INPUT_CLASS}
            placeholder="Phone number"
            required
            ariaInvalid={note?.field === 'phone'}
            ariaDescribedby={
              note?.field === 'phone' ? 'auth-form-error' : undefined
            }
          />
        )}
        <Field
          icon={Lock}
          name="password"
          type="password"
          placeholder="Password"
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          required
          minLength={isSignup ? 8 : undefined}
          defaultValue={signupDraft?.password}
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
            defaultValue={signupDraft?.password}
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
