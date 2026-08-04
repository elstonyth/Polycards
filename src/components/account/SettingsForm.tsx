'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { updateProfile, type ProfileCustomer } from '@/lib/actions/customer';
import { useAuth } from '@/components/auth/AuthProvider';
import { INPUT_CLASS } from '@/components/account/ui';
import { NAME_MAX, normalizePhone } from '@/lib/profile-validation';
import { PhoneField } from '@/components/PhoneField';
import { PhoneOtpStep } from '@/components/auth/PhoneOtpStep';
import { startPhoneOtp, changePhone } from '@/lib/actions/phone-verification';
import { PHONE_VERIFICATION_REQUIRED } from '@/lib/phone-verification';

// Read-only treatment shared by the email field and (under enforcement) the
// phone field — copied from the email input's classes below.
const READONLY_CLASS =
  'h-11 w-full cursor-not-allowed overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] px-3 text-sm text-ellipsis text-white/55 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-0';

// Real, wired profile form for the logged-in customer ("me"). Submits via the
// `updateProfile` server action (httpOnly-cookie Bearer, no client-side token).
// On success it syncs the header menu (AuthProvider) so a changed display name
// updates everywhere without a refetch flash. `email` is read-only — Medusa's
// store customer-update endpoint doesn't accept it.

type Props = { customer: ProfileCustomer };

export default function SettingsForm({ customer }: Props) {
  const router = useRouter();
  const { customer: authCustomer, setCustomer } = useAuth();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // Local phone display, so a verified change reflects immediately without
  // waiting on the router.refresh() below to re-fetch the server component.
  const [phone, setPhone] = useState(customer.phone ?? null);
  // National format for display — matches what the flag-off editable
  // PhoneField already shows (e.g. "010-766 7787", not raw "+60107667787");
  // the stored/submitted value stays E.164 either way.
  const displayPhone = phone
    ? (parsePhoneNumberFromString(phone)?.formatNational() ?? phone)
    : 'Not set';
  // Verified phone-change panel (PHONE_VERIFICATION_REQUIRED only): 'closed'
  // (read-only value + Change button) -> 'entry' (new-number PhoneField) ->
  // 'otp' (PhoneOtpStep). `pendingPhone` carries the normalized new number
  // from 'entry' into 'otp' (and into the changePhone call after verifying).
  const [phoneChange, setPhoneChange] = useState<'closed' | 'entry' | 'otp'>(
    'closed',
  );
  const [pendingPhone, setPendingPhone] = useState('');
  // 'entry' step's PhoneField isn't inside a <form> of its own (nesting it in
  // the outer profile <form> is invalid HTML and unpredictable) — read its
  // hidden E.164 input straight off the DOM instead of via FormData.
  const newPhoneWrapRef = useRef<HTMLDivElement>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setNote(null);

    const form = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const result = await updateProfile({
        first_name: String(form.get('first_name') ?? ''),
        last_name: String(form.get('last_name') ?? ''),
        // Under enforcement there's no editable phone field in this form
        // (see below) — phone writes go through changePhone instead.
        ...(PHONE_VERIFICATION_REQUIRED
          ? {}
          : { phone: String(form.get('phone') ?? '') }),
      });

      if (result.ok) {
        // Sync the header's user menu (AuthCustomer has no phone — drop it).
        // The profile handle and avatar are name-independent — carry the
        // current ones over.
        setCustomer({
          id: result.customer.id,
          email: result.customer.email,
          first_name: result.customer.first_name,
          last_name: result.customer.last_name,
          handle: authCustomer?.handle ?? null,
          avatar_url: authCustomer?.avatar_url ?? null,
        });
        setNote({ ok: true, text: 'Changes saved.' });
        router.refresh();
        return;
      }
      setNote({ ok: false, text: result.error });
    } catch {
      setNote({ ok: false, text: 'Couldn’t save changes. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  // 'entry' step: validate + send the OTP, then move to 'otp'.
  async function onSendCode() {
    if (busy) return;
    setNote(null);

    const raw =
      newPhoneWrapRef.current?.querySelector<HTMLInputElement>(
        'input[name="new_phone"]',
      )?.value ?? '';
    const normalized = normalizePhone(raw);
    if (!normalized) {
      setNote({
        ok: false,
        text: 'Please enter a valid phone number for the selected country.',
      });
      return;
    }

    setBusy(true);
    try {
      const result = await startPhoneOtp({
        phone: normalized,
        purpose: 'phone-change',
      });
      if (!result.ok) {
        setNote({ ok: false, text: result.error });
        return;
      }
      setPendingPhone(normalized);
      setPhoneChange('otp');
    } catch {
      setNote({ ok: false, text: 'Something went wrong. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (!PHONE_VERIFICATION_REQUIRED) {
    return (
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field
          label="Display name"
          name="first_name"
          defaultValue={customer.first_name ?? ''}
          autoComplete="given-name"
          placeholder="Your name"
          maxLength={NAME_MAX}
        />
        <Field
          label="Last name"
          name="last_name"
          defaultValue={customer.last_name ?? ''}
          autoComplete="family-name"
          placeholder="Optional"
          maxLength={NAME_MAX}
        />
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-white/55">
            Phone
          </span>
          <PhoneField
            name="phone"
            defaultValue={customer.phone ?? ''}
            inputClassName={INPUT_CLASS}
            placeholder="Phone number"
          />
          <span className="mt-1 block text-[11px] text-white/55">
            Used for delivery updates. Pick your country code.
          </span>
        </label>
        <EmailField email={customer.email} />
        <SaveRow busy={busy} note={note} />
      </form>
    );
  }

  // PHONE_VERIFICATION_REQUIRED: the name inputs + Save button must stay
  // mounted across every phoneChange sub-state, including 'otp' (which
  // renders PhoneOtpStep's own <form> — code input + Verify — and forms
  // can't validly nest). An earlier version of this file solved the nesting
  // problem by early-returning a DIFFERENT tree for the 'otp' state, which
  // unmounted the whole profile <form> — silently discarding an in-progress,
  // unsaved name edit the moment "Send code" was clicked. Fix: give the
  // profile form an id and associate the name inputs + Save button to it via
  // the `form` attribute (a real HTML input/button doesn't need to be a DOM
  // descendant of its form owner — `FormData(form)` follows that
  // association, not DOM nesting). The <form> element itself stays empty and
  // hidden; nothing is ever nested inside it, so nothing here can violate
  // the no-nested-forms rule regardless of phoneChange's value, and nothing
  // ever unmounts.
  return (
    <div className="flex flex-col gap-4">
      <form id="settings-profile" onSubmit={onSubmit} hidden />
      <Field
        label="Display name"
        name="first_name"
        form="settings-profile"
        defaultValue={customer.first_name ?? ''}
        autoComplete="given-name"
        placeholder="Your name"
        maxLength={NAME_MAX}
      />
      <Field
        label="Last name"
        name="last_name"
        form="settings-profile"
        defaultValue={customer.last_name ?? ''}
        autoComplete="family-name"
        placeholder="Optional"
        maxLength={NAME_MAX}
      />
      {/* Not a <label> — this block holds several interactive controls
          (Change button, or the entry/OTP step's own inputs), and a <label>
          forwards clicks/announces to only the first one. The read-only
          input below carries its own aria-label instead. */}
      <div className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-white/55">
          Phone
        </span>
        {phoneChange === 'closed' && (
          <div className="flex items-center gap-3">
            <input
              type="tel"
              value={displayPhone}
              readOnly
              aria-label="Phone (read-only)"
              className={READONLY_CLASS}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setNote(null);
                setPhoneChange('entry');
              }}
              className="h-11 shrink-0 rounded-xl border border-white/10 bg-white/[0.05] px-4 text-sm font-medium text-white transition-colors hover:bg-white/[0.1] disabled:opacity-70"
            >
              {/* "Add" for an account with no number yet — most accounts, and
                  the ones sent here by the topup/delivery verification gate.
                  Labelling that button "Change" reads as "change what?" and
                  makes the screen look like the wrong one. */}
              {phone ? 'Change' : 'Add'}
            </button>
          </div>
        )}
        {phoneChange === 'entry' && (
          // Not a <form> (nor form-associated) — its value is read straight
          // off the DOM via newPhoneWrapRef, not FormData, and Enter-to-send
          // is reimplemented via the PhoneField's onKeyDown below (associating
          // this PhoneField with settings-profile would make Enter trigger a
          // profile SAVE instead of Send code, via native implicit form
          // submission). Scoped to the tel input itself, not a wrapping div —
          // a div-level handler would also eat Enter on the country <select>.
          <div className="flex flex-col gap-2">
            <div ref={newPhoneWrapRef}>
              <PhoneField
                name="new_phone"
                defaultValue={pendingPhone}
                inputClassName={INPUT_CLASS}
                placeholder="New phone number"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void onSendCode();
                }}
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={onSendCode}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-neutral-200 px-4 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white disabled:opacity-70"
              >
                {busy && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                )}
                Send code
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setNote(null);
                  setPendingPhone('');
                  setPhoneChange('closed');
                }}
                className="text-[12px] text-white/55 hover:text-white disabled:opacity-70"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {phoneChange === 'otp' && (
          <PhoneOtpStep
            phone={pendingPhone}
            purpose="phone-change"
            onBack={() => setPhoneChange('entry')}
            onVerified={async (token) => {
              const result = await changePhone({ phone: pendingPhone, token });
              if (result.ok) {
                setPhone(result.phone);
                setPhoneChange('closed');
                setNote({ ok: true, text: 'Phone updated.' });
                router.refresh();
                return;
              }
              // Back to phone-entry (not 'closed') — the entry PhoneField's
              // defaultValue={pendingPhone} re-seeds the number so it isn't
              // lost.
              setPhoneChange('entry');
              setNote({ ok: false, text: result.error });
            }}
          />
        )}
        {phoneChange === 'closed' && (
          <span className="mt-1 block text-[11px] text-white/55">
            Changing your phone requires a verification code.
          </span>
        )}
      </div>
      <EmailField email={customer.email} />
      <SaveRow busy={busy} note={note} formAttr="settings-profile" />
    </div>
  );
}

function EmailField({ email }: { email: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-white/55">
        Email
      </span>
      <input
        type="email"
        value={email}
        readOnly
        aria-label="Email (read-only)"
        // A long address overflows the field on a 320px screen. It's
        // read-only, so there's no caret to scroll it into view — ellipsis at
        // least reads as truncation rather than a cut-off word.
        className={READONLY_CLASS}
      />
      <span className="mt-1 block text-[11px] text-white/55">
        Email can&apos;t be changed here.
      </span>
    </label>
  );
}

function SaveRow({
  busy,
  note,
  formAttr,
}: {
  busy: boolean;
  note: { ok: boolean; text: string } | null;
  formAttr?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="submit"
        form={formAttr}
        disabled={busy}
        className="inline-flex h-11 items-center justify-center gap-2 self-start rounded-xl bg-neutral-200 px-5 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white disabled:opacity-70"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Save changes
      </button>
      {note && (
        <span
          role="status"
          className={`text-[12px] ${note.ok ? 'text-buyback-fg' : 'text-red-400'}`}
        >
          {note.text}
        </span>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  ...props
}: {
  label: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-white/55">
        {label}
      </span>
      <input
        aria-label={props['aria-label'] ?? label}
        {...props}
        className={INPUT_CLASS}
      />
      {hint && (
        <span className="mt-1 block text-[11px] text-white/55">{hint}</span>
      )}
    </label>
  );
}
