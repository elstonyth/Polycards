'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useAuth } from '@/components/auth/AuthProvider';
import { INPUT_CLASS, Panel } from '@/components/account/ui';
import { disableAccount, deleteAccount } from '@/lib/actions/account-lifecycle';
// NOT from './account-lifecycle': that module is 'use server' and may export
// only async functions. Next injects a runtime validator that rejects a plain
// object export, and even without it a client component importing from a
// 'use server' module receives server-reference proxies rather than values —
// DELETE_LINK[reason].href would silently be undefined. Task 8 split these out
// for exactly this reason.
import {
  CONFIRM_WORD,
  DELETE_LINK,
  deleteConfirmReady,
} from '@/lib/actions/account-lifecycle-map';

function Modal({
  open,
  label,
  busy,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, open, onClose);
  if (!open) return null;
  return (
    <div className="glass-stage fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-busy={busy}
        tabIndex={-1}
        className="glass-panel max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border p-5 outline-none"
      >
        {children}
      </div>
    </div>
  );
}

export default function DangerZone({ hasPassword }: { hasPassword: boolean }) {
  const router = useRouter();
  const { setCustomer } = useAuth();
  const [mode, setMode] = useState<'none' | 'disable' | 'delete'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The machine-readable refusal code, kept beside the copy so the modal can
  // offer the page that CLEARS the blocker. Every delete refusal is something
  // the customer can only fix somewhere else, so an instruction with no route
  // is a dead end.
  const [reason, setReason] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmWord, setConfirmWord] = useState('');

  const close = () => {
    if (busy) return;
    setMode('none');
    setError(null);
    setReason(null);
    setPassword('');
    setConfirmWord('');
  };

  // Post-action navigation is client-side: no server action in this repo calls
  // redirect(). Mirrors MeActions.tsx's LogoutButton. This IS the goodbye —
  // there is no separate goodbye screen, because it would be a route that
  // exists to be seen once by someone who has just left; the logged-out home
  // page already says it.
  const leave = () => {
    setCustomer(null);
    router.push('/');
    router.refresh();
  };

  async function onDisable() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await disableAccount();
      if (r.ok) {
        leave();
        return;
      }
      setError(r.error);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setReason(null);
    try {
      const r = await deleteAccount(hasPassword ? password : null);
      if (r.ok) {
        leave();
        return;
      }
      setError(r.error);
      setReason(r.reason);
    } finally {
      setBusy(false);
    }
  }

  const deleteReady = deleteConfirmReady({
    hasPassword,
    password,
    confirmWord,
  });
  // Read once into a local: `noUncheckedIndexedAccess` types the lookup as
  // possibly-undefined, and the password refusals deliberately have no entry.
  const link = reason ? DELETE_LINK[reason] : undefined;

  return (
    <Panel className="border-red-500/25">
      <h2 className="mb-1 font-heading text-lg font-bold text-white">
        Danger zone
      </h2>
      <p className="mb-4 text-[13px] text-white/55">
        Disabling is reversible — log back in any time to reactivate. Deleting
        is not.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => setMode('disable')}
          className="h-11 shrink-0 rounded-xl border border-white/10 bg-white/[0.05] px-4 text-sm font-medium text-white transition-colors hover:bg-white/[0.1]"
        >
          Disable account
        </button>
        <button
          type="button"
          onClick={() => setMode('delete')}
          className="h-11 shrink-0 rounded-xl border border-red-500/30 bg-red-500/10 px-4 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/20"
        >
          Delete account
        </button>
      </div>

      <Modal
        open={mode === 'disable'}
        label="Disable account"
        busy={busy}
        onClose={close}
      >
        <h3 className="font-heading text-lg font-bold text-white">
          Disable your account?
        </h3>
        <p className="mt-2 text-[13px] text-white/60">
          You&rsquo;ll be signed out and your account stays closed until you log
          back in and reactivate it. Your cards, balance and history are
          untouched.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-[12px] text-red-400">
            {error}
          </p>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onDisable}
            disabled={busy}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-white text-sm font-bold text-neutral-950 transition-colors hover:bg-white/90 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {busy ? 'Disabling…' : 'Disable'}
          </button>
        </div>
      </Modal>

      <Modal
        open={mode === 'delete'}
        label="Delete account"
        busy={busy}
        onClose={close}
      >
        <h3 className="font-heading text-lg font-bold text-white">
          Delete your account permanently?
        </h3>
        <p className="mt-2 text-[13px] text-white/60">
          This cannot be undone. Your profile, saved bank accounts and personal
          details are erased and you will not be able to log in again — not even
          with support&rsquo;s help.
        </p>
        {hasPassword ? (
          <label className="mt-4 block">
            <span className="mb-1.5 block text-[12px] font-medium text-white/55">
              Your password
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className={INPUT_CLASS}
            />
          </label>
        ) : (
          <p className="mt-4 text-[12px] text-white/55">
            You sign in with Google, so there&rsquo;s no password to enter —
            type {CONFIRM_WORD} below to confirm.
          </p>
        )}
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[12px] font-medium text-white/55">
            Type {CONFIRM_WORD} to confirm
          </span>
          <input
            type="text"
            autoComplete="off"
            value={confirmWord}
            onChange={(e) => setConfirmWord(e.target.value)}
            disabled={busy}
            className={INPUT_CLASS}
          />
        </label>
        {error && (
          <div role="alert" className="mt-3 text-[12px] text-red-400">
            <p>{error}</p>
            {/* Every settlement refusal is fixed on another page, so the copy
                ships with the route that fixes it. Password failures have no
                entry in the map and correctly render copy alone. */}
            {link && (
              <Link
                href={link.href}
                className="mt-1 inline-block font-semibold text-red-300 underline underline-offset-2 hover:text-red-200"
              >
                {link.label}
              </Link>
            )}
          </div>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy || !deleteReady}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-bold text-white transition-colors hover:bg-red-500 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {busy ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </Modal>
    </Panel>
  );
}
