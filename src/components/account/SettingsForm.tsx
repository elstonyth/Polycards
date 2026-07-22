'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { updateProfile, type ProfileCustomer } from '@/lib/actions/customer';
import { useAuth } from '@/components/auth/AuthProvider';
import { INPUT_CLASS } from '@/components/account/ui';

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

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setNote(null);

    const form = new FormData(e.currentTarget);
    setBusy(true);
    const result = await updateProfile({
      first_name: String(form.get('first_name') ?? ''),
      last_name: String(form.get('last_name') ?? ''),
      phone: String(form.get('phone') ?? ''),
    });
    setBusy(false);

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
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field
        label="Display name"
        name="first_name"
        defaultValue={customer.first_name ?? ''}
        autoComplete="given-name"
        placeholder="Your name"
      />
      <Field
        label="Last name"
        name="last_name"
        defaultValue={customer.last_name ?? ''}
        autoComplete="family-name"
        placeholder="Optional"
      />
      <Field
        label="Phone"
        name="phone"
        type="tel"
        defaultValue={customer.phone ?? ''}
        autoComplete="tel"
        placeholder="Optional"
      />
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-white/55">
          Email
        </span>
        <input
          type="email"
          value={customer.email}
          readOnly
          aria-label="Email (read-only)"
          // A long address overflows the field on a 320px screen. It's
          // read-only, so there's no caret to scroll it into view — ellipsis at
          // least reads as truncation rather than a cut-off word.
          className="h-11 w-full cursor-not-allowed overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] px-3 text-sm text-ellipsis text-white/55 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-0"
        />
        <span className="mt-1 block text-[11px] text-white/55">
          Email can&apos;t be changed here.
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
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
    </form>
  );
}

function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
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
    </label>
  );
}
