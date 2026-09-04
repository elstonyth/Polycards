'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { updateProfile, type ProfileCustomer } from '@/lib/actions/customer';
import { useAuth } from '@/components/auth/AuthProvider';
import { INPUT_CLASS } from '@/components/account/ui';
import {
  NAME_MAX,
  normalizePhone,
  usernameError,
} from '@/lib/profile-validation';
import { PhoneField } from '@/components/PhoneField';
import { PhoneOtpStep } from '@/components/auth/PhoneOtpStep';
import { startPhoneOtp, changePhone } from '@/lib/actions/phone-verification';
import { PHONE_VERIFICATION_REQUIRED } from '@/lib/phone-verification';
import { SITE_URL } from '@/lib/site';

// The profile-link preview shows a host, not a full URL — the deployed origin
// where there is one, so a dev build doesn't promise a polycards.gg link it
// isn't serving.
const SITE_HOST = SITE_URL.replace(/^https?:\/\//, '');

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
  // The username is the profile URL, so the field shows the link it is about to
  // become as you type. Tracked rather than read on submit because the point is
  // to make the consequence visible BEFORE saving — someone renaming themselves
  // is also retiring their old link, and nothing else on this page says so.
  const [nameDraft, setNameDraft] = useState(customer.first_name ?? '');
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
  // 'otp' (PhoneOtpStep) -> optionally 'old-otp'. `pendingPhone` carries the
  // normalized new number from 'entry' into 'otp' (and into the changePhone
  // call after verifying).
  //
  // 'old-otp' exists for ONE cohort: a Google-only account that already has a
  // phone. The backend refuses to move that account's number on the new-number
  // proof alone — with no password to ask for, the equivalent identity proof is
  // an OTP to the number being moved AWAY from — and it is the only thing that
  // knows which cohort this is (see changePhone's `needsOldPhoneProof`). So the
  // flow ATTEMPTS the change and adds this step only when the route asks for it.
  const [phoneChange, setPhoneChange] = useState<
    'closed' | 'entry' | 'otp' | 'old-otp'
  >('closed');
  const [pendingPhone, setPendingPhone] = useState('');
  // The new number's proof token, held only long enough to survive the round
  // trip through 'old-otp' and be replayed with the second proof. The OLD
  // number's token is deliberately never stored — it is consumed in the same
  // call that mints it.
  const [newPhoneToken, setNewPhoneToken] = useState('');
  // The backend refuses to MOVE a phone on a session alone (see the re-auth
  // gate in store/phone-verification/change/route.ts): a stolen session could
  // otherwise take the recovery number and turn itself into a permanent
  // takeover via the phone password-reset. Collected in the 'entry' step rather
  // than after the OTP so the whole ask is on one screen, and NOT `required` —
  // an account with no password (Google-only, adding its first number) must
  // still be able to submit, and the backend answers those cases itself.
  const [currentPassword, setCurrentPassword] = useState('');
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
        // The handle is NOT name-independent any more: it IS the display name,
        // so it has to be re-read from the saved customer. Carrying the old one
        // over — which this did — left the "My profile" link pointing at the
        // URL the rename had just vacated, i.e. a 404.
        setCustomer({
          id: result.customer.id,
          email: result.customer.email,
          first_name: result.customer.first_name,
          last_name: result.customer.last_name,
          handle: result.customer.first_name,
          avatar_url: authCustomer?.avatar_url ?? null,
        });
        setNameDraft(result.customer.first_name ?? '');
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

  // Everything the phone-change flow holds that must not outlive it: the
  // account password and the new number's proof token. Same posture 080 took
  // with the password alone — a live credential or proof sitting in state after
  // the flow it belonged to is a bug waiting for the next edit.
  function clearPhoneChangeSecrets() {
    setCurrentPassword('');
    setNewPhoneToken('');
  }

  // The change call itself, shared by both proof paths. The first attempt
  // carries the password (emailpass accounts); the retry additionally carries a
  // proof for the CURRENT number (Google-only accounts that already have one).
  async function submitPhoneChange(token: string, oldPhoneToken?: string) {
    const result = await changePhone({
      phone: pendingPhone,
      token,
      password: currentPassword,
      oldPhoneToken,
    });
    if (result.ok) {
      setPhone(result.phone);
      clearPhoneChangeSecrets();
      setPhoneChange('closed');
      setNote({ ok: true, text: 'Phone updated.' });
      router.refresh();
      return;
    }
    // `!oldPhoneToken` bounds the retry to one round: if the second attempt is
    // refused the same way, fall through to the error instead of looping.
    if (result.needsOldPhoneProof && !oldPhoneToken) {
      await startOldPhoneOtp();
      return;
    }
    // Back to phone-entry (not 'closed') — the entry PhoneField's
    // defaultValue={pendingPhone} re-seeds the number so it isn't lost. The
    // password stays too, so a rate-limited or mistyped attempt doesn't cost a
    // retype; only the spent proof is dropped.
    setNewPhoneToken('');
    setPhoneChange('entry');
    setNote({ ok: false, text: result.error });
  }

  // Second proof, for the number being moved AWAY from. `phone` is the stored
  // E.164 value — startPhoneOtp's normalizePhone accepts E.164 as-is, and its
  // served-country guard passes for anything the picker could have written, so
  // a legitimate stored number is not blocked. A stored number outside the
  // served set gets a clear message here rather than an SMS that silently never
  // arrives, which is the same answer the NEW number would get.
  async function startOldPhoneOtp() {
    if (!phone) {
      // The backend only asks for this when a phone is on the row, so a null
      // here means local state drifted from the server. Say so rather than
      // send an OTP to nothing.
      setPhoneChange('entry');
      setNote({ ok: false, text: 'Please refresh the page and try again.' });
      return;
    }
    const sent = await startPhoneOtp({ phone, purpose: 'phone-change' });
    if (!sent.ok) {
      setPhoneChange('entry');
      setNote({ ok: false, text: sent.error });
      return;
    }
    setNote(null);
    setPhoneChange('old-otp');
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
        <UsernameField value={nameDraft} onValueChange={setNameDraft} />
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
      <UsernameField
        value={nameDraft}
        onValueChange={setNameDraft}
        form="settings-profile"
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
                clearPhoneChangeSecrets();
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
            {/* Not form-associated, for the same reason the PhoneField above
                isn't: this block lives outside the profile <form>, and wiring
                it in would make Enter here trigger a profile SAVE. */}
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-white/55">
                Current password
              </span>
              <input
                type="password"
                name="current_password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void onSendCode();
                }}
                placeholder="Your account password"
                className={INPUT_CLASS}
              />
              <span className="mt-1 block text-[11px] text-white/55">
                Confirms it&apos;s really you before your recovery number moves.
              </span>
            </label>
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
                  // Don't leave a password or a proof token sitting in state
                  // for a flow the user abandoned.
                  clearPhoneChangeSecrets();
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
            onBack={() => {
              setNewPhoneToken('');
              setPhoneChange('entry');
            }}
            onVerified={async (token) => {
              // Held in state as well as passed along: if the backend comes
              // back asking for the old number too, this token has to survive
              // the re-render into the 'old-otp' step and be replayed there.
              setNewPhoneToken(token);
              await submitPhoneChange(token);
            }}
          />
        )}
        {phoneChange === 'old-otp' && (
          // Its OWN conditional slot rather than a branch inside the 'otp'
          // block above. React reconciles children by position, so two slots
          // unmount one PhoneOtpStep and mount a fresh one for the second
          // number; sharing a slot would REUSE the instance, and its `busy`
          // flag — set true just before it hands the token up and deliberately
          // never cleared, because the parent is expected to unmount it —
          // would arrive stuck, leaving Verify permanently disabled.
          <div className="flex flex-col gap-2">
            <p className="text-[12px] text-white/55">
              This account has no password, so we also need to confirm the
              number you&apos;re moving away from.
            </p>
            <PhoneOtpStep
              // Non-null: startOldPhoneOtp refuses to enter this state without
              // a stored number.
              phone={phone ?? ''}
              purpose="phone-change"
              onBack={() => {
                setNewPhoneToken('');
                setPhoneChange('entry');
              }}
              onVerified={async (oldToken) => {
                await submitPhoneChange(newPhoneToken, oldToken);
              }}
            />
          </div>
        )}
        {phoneChange === 'closed' && (
          <span className="mt-1 block text-[11px] text-white/55">
            Changing your phone requires a verification code, and your account
            password if you have one.
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

/**
 * The username field — the one input on this page that also rewrites a URL.
 *
 * It shows the link live rather than describing it, because the consequence is
 * not obvious from a text box: changing this retires the old /profile/<name>
 * address, and anyone who bookmarked or shared it lands on a 404. Saying so
 * next to the value being typed is the only place that warning is actually read.
 *
 * Validation is local and immediate (`usernameError`), but it is a courtesy —
 * the backend's username guard is what refuses a bad or taken name, and the
 * unique index behind it is what makes "no two people, one link" true.
 */
function UsernameField({
  value,
  onValueChange,
  form,
}: {
  value: string;
  onValueChange: (next: string) => void;
  form?: string;
}) {
  const trimmed = value.trim();
  // Only complain about a name they have actually started typing; an empty
  // field on first paint is not yet a mistake.
  const error = trimmed === '' ? null : usernameError(trimmed);
  return (
    <Field
      label="Username"
      name="first_name"
      form={form}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      autoComplete="nickname"
      placeholder="Your username"
      maxLength={NAME_MAX}
      aria-invalid={error ? true : undefined}
      hint={
        error ??
        (trimmed === ''
          ? 'This is also your public profile link.'
          : `Your profile link: ${SITE_HOST}/profile/${trimmed} — changing it retires the old one.`)
      }
      hintTone={error ? 'error' : 'muted'}
    />
  );
}

function Field({
  label,
  hint,
  hintTone = 'muted',
  ...props
}: {
  label: string;
  hint?: string;
  hintTone?: 'muted' | 'error';
} & React.InputHTMLAttributes<HTMLInputElement>) {
  // The hint carries the validation error (see UsernameField), so it has to be
  // announced with the input rather than read as loose text after it —
  // aria-invalid alone says "wrong" without saying what is wrong.
  const hintId = useId();
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-white/55">
        {label}
      </span>
      <input
        aria-label={props['aria-label'] ?? label}
        aria-describedby={hint ? hintId : undefined}
        {...props}
        className={INPUT_CLASS}
      />
      {hint && (
        <span
          id={hintId}
          className={`mt-1 block text-[11px] ${
            hintTone === 'error' ? 'text-red-400' : 'text-white/55'
          }`}
        >
          {hint}
        </span>
      )}
    </label>
  );
}
