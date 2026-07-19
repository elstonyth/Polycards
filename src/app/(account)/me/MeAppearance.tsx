'use client';

import { useState } from 'react';
import { Check, Copy, Pencil } from 'lucide-react';
import { FramedAvatar } from '@/components/FramedAvatar';
import { num } from '@/lib/format';
import { EditProfileModal } from './EditProfileModal';
import { useEquippedFrame } from './equipped-frame';

/**
 * Me-page header: framed avatar, name, pull stats, and a copyable @handle chip
 * — the Show "Me" header adapted to Polycards data.
 *
 * Tapping the avatar OR the name opens the Edit Profile modal, which owns the
 * photo (crop → upload) and frame controls. They used to be a photo-only
 * shortcut here plus a separate frames card lower on the page; the operator
 * asked for the Show layout where both live behind the name (2026-07-19).
 */
export function MeHeader({
  displayName,
  handle,
  pulls,
  avatarUrl,
  frames,
  highestLevel,
}: {
  displayName: string;
  handle: string | null;
  /** null = profile read unavailable — the stats row is hidden. */
  pulls: number | null;
  avatarUrl: string | null;
  frames: Record<string, string>;
  /** null = the VIP read failed — the modal shows "couldn't load". */
  highestLevel: number | null;
}) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const { equipped } = useEquippedFrame();
  const initial = (displayName[0] ?? '?').toUpperCase();
  const equippedFrameUrl = equipped ? (frames[String(equipped)] ?? null) : null;

  async function copyHandle() {
    if (!handle) return;
    try {
      await navigator.clipboard.writeText(`@${handle}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — nothing actionable; the handle is on screen.
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit profile photo and frame"
          className="group relative shrink-0 rounded-full outline-offset-4"
        >
          <FramedAvatar
            src={avatarUrl}
            initial={initial}
            frameSrc={equippedFrameUrl}
            animateLevel={equipped}
            size={72}
            priority
          />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-white/20 bg-neutral-800 text-white transition-colors group-hover:bg-neutral-700">
            <Pencil className="h-3 w-3" aria-hidden />
          </span>
        </button>
        <div className="min-w-0">
          {/* Still the page's h1 — the name became a button, not a heading. */}
          <h1 className="min-w-0">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="font-heading flex max-w-full items-center gap-1.5 truncate text-2xl text-white transition-colors hover:text-white/80"
            >
              <span className="truncate">{displayName}</span>
              <Pencil
                className="h-3.5 w-3.5 shrink-0 text-neutral-500"
                aria-hidden
              />
            </button>
          </h1>
          {pulls !== null && (
            <p className="mt-1 text-[13px] text-neutral-400">
              <span className="font-semibold text-white">{num(pulls)}</span>{' '}
              Pulls
            </p>
          )}
          {handle && (
            <button
              type="button"
              onClick={() => void copyHandle()}
              className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[12px] font-semibold text-neutral-300 transition-colors hover:text-white"
            >
              <span className="truncate">@{handle}</span>
              {copied ? (
                <Check
                  className="h-3 w-3 shrink-0 text-emerald-400"
                  aria-hidden
                />
              ) : (
                <Copy className="h-3 w-3 shrink-0" aria-hidden />
              )}
              <span className="sr-only">
                {copied ? 'Copied' : 'Copy handle'}
              </span>
            </button>
          )}
        </div>
      </div>

      <EditProfileModal
        open={editing}
        onClose={() => setEditing(false)}
        displayName={displayName}
        handle={handle}
        avatarUrl={avatarUrl}
        frames={frames}
        highestLevel={highestLevel}
      />
    </section>
  );
}
