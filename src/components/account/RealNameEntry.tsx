'use client';

import { useId, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Pill } from '@/components/ui/pill';
import { INPUT_CLASS } from '@/components/account/ui';
import { saveRealName } from '@/lib/actions/customer';
import {
  normalizeRealName,
  REAL_NAME_HINT,
  REAL_NAME_INVALID,
  REAL_NAME_MAX,
} from '@/lib/real-name';

/**
 * The real-name write as two steps — type it, then confirm it read back — so
 * the one-time save (spec 2026-10-06) is never a single mistaken tap. Shared by
 * the account gate (RealNameModal) and Settings.
 *
 * `onSaved` runs after the backend stored the name. A refusal because a name
 * is ALREADY on file (another tab, or customer service) is reported like any
 * other error; a reload then shows the stored one.
 */
export function RealNameEntry({
  onSaved,
}: {
  onSaved: (realName: string) => void;
}) {
  const [step, setStep] = useState<'entry' | 'confirm'>('entry');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const hintId = useId();

  function onReview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = normalizeRealName(draft);
    if (!name) {
      setError(REAL_NAME_INVALID);
      return;
    }
    setError(null);
    setDraft(name);
    setStep('confirm');
  }

  async function onConfirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveRealName({ real_name: draft });
      if (result.ok) {
        onSaved(result.realName);
        return;
      }
      setError(result.error);
      setStep('entry');
    } catch {
      setError('Something went wrong. Please try again.');
      setStep('entry');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'confirm') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[12px] text-white/55">Is this exactly right?</p>
        <p className="rounded-xl border border-white/15 bg-white/[0.05] px-3 py-3 text-base font-semibold break-words text-white">
          {draft}
        </p>
        <p className="text-[12px] leading-relaxed text-white/55">
          {REAL_NAME_HINT} Only customer service can correct it after you
          confirm.
        </p>
        <Pill
          type="button"
          size="lg"
          disabled={busy}
          onClick={onConfirm}
          className="w-full"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Confirm real name
        </Pill>
        <button
          type="button"
          disabled={busy}
          onClick={() => setStep('entry')}
          className="min-h-11 text-[13px] font-medium text-neutral-400 transition-colors hover:text-white disabled:opacity-50"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onReview} className="flex flex-col gap-3">
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-white/55">
          Full name (as on your IC)
        </span>
        <input
          type="text"
          name="real_name"
          autoComplete="name"
          maxLength={REAL_NAME_MAX}
          required
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hintId}
          className={INPUT_CLASS}
        />
        <span id={hintId} className="mt-1 block text-[11px] text-white/55">
          {REAL_NAME_HINT}
        </span>
      </label>
      <p
        id={errorId}
        aria-live="assertive"
        aria-atomic="true"
        className={error ? 'text-[12px] text-red-400' : 'sr-only'}
      >
        {error}
      </p>
      <Pill type="submit" size="lg" className="w-full">
        Continue
      </Pill>
    </form>
  );
}
