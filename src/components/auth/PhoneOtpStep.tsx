'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { startPhoneOtp, checkPhoneOtp } from '@/lib/actions/phone-verification';
import type { PhoneOtpPurpose } from '@/lib/phone-verification';

const RESEND_COOLDOWN_S = 30;

/** Code-entry step shared by signup, phone-change, and forgot-by-phone.
 * The PARENT sends the first code (so it can gate on its own validation);
 * this step owns re-sends, the code input, and the check call. */
export function PhoneOtpStep({
  phone,
  purpose,
  onVerified,
  onBack,
}: {
  phone: string;
  purpose: PhoneOtpPurpose;
  onVerified: (token: string) => void | Promise<void>;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus once on mount only — NOT on every cooldown tick (that would yank
  // focus off Resend/Back once a second).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => c - 1), 1_000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    setBusy(true);
    // The actions catch BACKEND errors themselves; the try is for the action
    // CALL rejecting (offline, a mid-deploy action-id mismatch), which would
    // otherwise leave Verify and Resend disabled for good.
    try {
      const result = await checkPhoneOtp({ phone, purpose, code });
      if (result.ok) {
        await onVerified(result.token); // parent owns the next transition
        return; // parent unmounts us; don't touch state after
      }
      setError(result.error);
    } catch {
      setError('Something went wrong. Please try again.');
    }
    setBusy(false);
  }

  async function onResend() {
    if (busy || cooldown > 0) return;
    setError(null);
    setBusy(true);
    // Set the cooldown BEFORE the request resolves — a double-click while the
    // first request is in flight must not fire a second SMS (the start route
    // is budgeted at 3/60s and each send costs real money).
    setCooldown(RESEND_COOLDOWN_S);
    try {
      const result = await startPhoneOtp({ phone, purpose });
      if (!result.ok) setError(result.error);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full">
      <p className="text-sm text-white/50">
        Enter the 6-digit code we sent to{' '}
        <span className="text-white">{phone}</span>.
      </p>
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
        <input
          ref={inputRef}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d*"
          maxLength={10}
          placeholder="Verification code"
          aria-label="Verification code"
          className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.05] px-3 text-center text-lg tracking-[0.3em] text-white placeholder:text-sm placeholder:tracking-normal placeholder:text-white/50 focus:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          required
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-300 text-sm font-semibold text-neutral-950 transition-colors hover:to-neutral-100 disabled:opacity-70"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Verify
        </button>
      </form>
      <p
        aria-live="assertive"
        aria-atomic="true"
        className={
          error ? 'mt-3 text-center text-[12px] text-red-400' : 'sr-only'
        }
      >
        {error}
      </p>
      <div className="mt-4 flex items-center justify-between text-[13px] text-white/50">
        <button type="button" onClick={onBack} className="hover:text-white">
          Back
        </button>
        <button
          type="button"
          onClick={onResend}
          disabled={busy || cooldown > 0}
          className="font-semibold text-white disabled:font-normal disabled:text-white/40"
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
        </button>
      </div>
    </div>
  );
}
