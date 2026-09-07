'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldCheck } from 'lucide-react';
import { PhoneField } from '@/components/PhoneField';
import { PhoneOtpStep } from '@/components/auth/PhoneOtpStep';
import { Pill } from '@/components/ui/pill';
import { INPUT_CLASS } from '@/components/account/ui';
import { useAuth } from '@/components/auth/AuthProvider';
import { logout } from '@/lib/actions/auth';
import { changePhone, startPhoneOtp } from '@/lib/actions/phone-verification';
import type { PhoneOtpChannel } from '@/lib/phone-verification';
import { normalizePhone } from '@/lib/profile-validation';
import { useModalA11y } from '@/lib/use-modal-a11y';

// Escape is deliberately inert: the gate has no dismiss (see below).
const noop = () => {};

/**
 * The phone gate for an account that has no number yet. A phone is REQUIRED
 * to hold an account (operator decision 2026-09-08): the emailpass form
 * collects and verifies one at signup, and a first Google login is the one
 * path that arrives without one. The account layout mounts this over every
 * account page for that cohort until a number is verified — there is no Skip,
 * Escape does nothing, and the only other way out is Log out.
 *
 * Same two steps as SettingsForm's Add-phone flow (PhoneField → PhoneOtpStep
 * → changePhone) minus its re-auth branches: a Google-only account adding its
 * FIRST phone is the one path the backend accepts on the new-number proof
 * alone (store/phone-verification/change/route.ts's re-auth gate). That is
 * also why the layout mounts it only for password-less accounts — a password
 * account would be asked here for a password this modal has no field for.
 *
 * The first code can go out by SMS or by voice call from the entry step. The
 * code step's own "Get a call instead" sits behind a 30s cooldown, and
 * someone whose carrier drops SMS (the Digi/016 case PhoneOtpStep documents)
 * should not have to wait it out inside a gate they cannot leave.
 */
export function PhoneOnboardingModal() {
  const router = useRouter();
  const { setCustomer } = useAuth();
  const panelRef = useRef<HTMLDivElement>(null);
  // The entry form, read by both senders (submit → SMS, button → call).
  const formRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState<'entry' | 'otp'>('entry');
  // Normalized E.164, carried from 'entry' into 'otp' and the changePhone call.
  const [phone, setPhone] = useState('');
  // How the first code went out, so the code step's copy matches.
  const [channel, setChannel] = useState<PhoneOtpChannel>('sms');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set after a successful save: hides the gate for the beat between the
  // write landing and router.refresh() re-rendering the layout without it.
  const [done, setDone] = useState(false);

  useModalA11y(panelRef, !done, noop);

  // One sender for both entry-step controls: the form's submit (SMS) and the
  // "get a call" button, which reads the same form.
  async function send(form: HTMLFormElement, via: PhoneOtpChannel) {
    if (busy) return;
    setError(null);
    // PhoneField submits E.164 in its hidden input.
    const normalized = normalizePhone(
      String(new FormData(form).get('phone') ?? ''),
    );
    if (!normalized) {
      setError('Please enter a valid phone number for the selected country.');
      return;
    }
    setBusy(true);
    try {
      const result = await startPhoneOtp({
        phone: normalized,
        purpose: 'phone-change',
        // Omitted for SMS — the backend default; sent only when asked for.
        ...(via === 'call' ? { channel: via } : {}),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPhone(normalized);
      setChannel(via);
      setStep('otp');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send(e.currentTarget, 'sms');
  }

  async function onVerified(token: string) {
    const result = await changePhone({ phone, token });
    if (result.ok) {
      setDone(true);
      // The layout reads the phone server-side; a refresh drops the gate and
      // clears /me's Settings-tile highlight.
      router.refresh();
      return;
    }
    // Back to entry with the refusal. Not a retry-in-place: PhoneOtpStep's
    // busy flag is only cleared by unmounting it (see SettingsForm's
    // 'old-otp' note), and every refusal here needs a different number or a
    // fresh code anyway. `needsOldPhoneProof` is the one exception: the
    // backend only asks for it when a phone is ALREADY on the row, so this
    // tab is stale — the number was verified elsewhere (another tab) — and
    // no code entered here can fix that.
    setError(
      result.needsOldPhoneProof
        ? 'Your phone number was already saved. Reload the page to continue.'
        : result.error,
    );
    setStep('entry');
  }

  // The escape hatch for someone who cannot receive a code at all (a number
  // outside the served countries, a lost handset). Same sequence as /me's
  // LogoutButton.
  async function onLogout() {
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

  if (done) return null;

  return (
    // z-[60]: above the app header and TabBar (both z-50) so the gate really
    // gates — a tab tap must not walk out from under it. Below TopUpSheet
    // (z-[70]) and AuthModal (z-[100]), neither of which can open from here.
    <div className="glass-stage fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="phone-onboarding-title"
        aria-busy={busy}
        tabIndex={-1}
        className="glass-panel max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border p-6 outline-none sm:p-7"
      >
        {/* Monochrome badge, not gold: DESIGN.md reserves Chase Gold for prize
            and value moments, and this is a security step. */}
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
          <ShieldCheck className="h-5 w-5 text-white" aria-hidden />
        </span>
        <h2
          id="phone-onboarding-title"
          className="font-heading mt-4 text-2xl text-white"
        >
          Verify your phone
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          A verified phone number is required to finish setting up your account.
          It secures your account and unlocks top-ups, withdrawals and
          deliveries. We&apos;ll text you a code, or call you with it.
        </p>

        {step === 'entry' ? (
          <form
            ref={formRef}
            onSubmit={onSubmit}
            className="mt-5 flex flex-col gap-3"
          >
            {/* Not a <label>: PhoneField holds two controls (country picker +
                number) and each carries its own aria-label. */}
            <div>
              <span className="mb-1.5 block text-[12px] font-medium text-white/55">
                Phone number
              </span>
              <PhoneField
                name="phone"
                // Re-seeds the number after a changePhone refusal sent them
                // back here (an expired proof wants the SAME number again) —
                // the SettingsForm entry step does the same.
                defaultValue={phone}
                inputClassName={INPUT_CLASS}
                placeholder="12-345 6789"
                ariaInvalid={Boolean(error)}
                ariaDescribedby="phone-onboarding-error"
              />
            </div>
            <p
              id="phone-onboarding-error"
              aria-live="assertive"
              aria-atomic="true"
              className={error ? 'text-[12px] text-red-400' : 'sr-only'}
            >
              {error}
            </p>
            <Pill type="submit" size="lg" disabled={busy} className="w-full">
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Send code
            </Pill>
            {/* type="button", not a second submit: the form's submit is the
                SMS path, and Enter in the number field must keep meaning SMS. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (formRef.current) void send(formRef.current, 'call');
              }}
              className="min-h-11 text-[13px] font-medium text-neutral-400 transition-colors hover:text-white disabled:opacity-50"
            >
              Can&apos;t receive SMS? Get a call instead
            </button>
          </form>
        ) : (
          <div className="mt-5">
            <PhoneOtpStep
              phone={phone}
              purpose="phone-change"
              channel={channel}
              onBack={() => {
                setError(null);
                setStep('entry');
              }}
              onVerified={onVerified}
            />
          </div>
        )}

        <p className="mt-5 text-center text-[12px] text-neutral-400">
          Can&apos;t verify right now?{' '}
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
