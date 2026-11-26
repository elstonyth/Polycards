'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Check, Copy, Pencil } from 'lucide-react';
import { FramedAvatar } from '@/components/FramedAvatar';
import { EditProfileModal } from './EditProfileModal';
import { useEquippedFrame } from './equipped-frame';

const CHIP =
  'relative inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-neutral-800 px-2 text-[12px] font-medium text-neutral-300 transition-colors after:absolute after:-inset-y-1.5 after:inset-x-0 hover:text-white';

/**
 * The Me page's profile row (top of the tier card): the framed avatar, the
 * name, a copyable @handle chip and an Edit chip.
 *
 * Tapping the avatar, the name OR Edit opens the Edit Profile modal, which
 * owns the photo (crop → upload), catalog avatar, username and frame controls.
 * Photo and frames used to be a photo-only shortcut here plus a separate
 * frames card lower on the page; the operator asked for the Show layout where
 * both live behind the name (2026-07-19), and the username joined them on
 * 2026-10-03. The Edit chip says the avatar and name can be tapped.
 */
export function MeHeader({
  displayName,
  username,
  handle,
  avatarUrl,
  frames,
  highestLevel,
  vipBadge,
}: {
  displayName: string;
  /** first_name alone — the editable part of displayName. */
  username: string;
  handle: string | null;
  avatarUrl: string | null;
  frames: Record<string, string>;
  /** null = the VIP read failed — the modal shows "couldn't load". */
  highestLevel: number | null;
  /** The VIP badge beside the name (off when the VIP read failed). */
  vipBadge: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  // A catalog pick made in the modal: picks don't re-read the page per tap.
  const [pickedAvatar, setPickedAvatar] = useState<string | null>(null);
  const shownAvatar = pickedAvatar ?? avatarUrl;
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
    <div className="flex min-w-0 items-center gap-3">
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label="Edit profile photo and frame"
        className="me-pop shrink-0 rounded-full outline-offset-4"
      >
        <FramedAvatar
          src={shownAvatar}
          initial={initial}
          frameSrc={equippedFrameUrl}
          animateLevel={equipped}
          size={60}
          priority
          className={
            equippedFrameUrl ? undefined : 'rounded-full ring-1 ring-white/10'
          }
        />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {/* The page's h1 — the name is a button inside it. */}
          <h1 className="min-w-0">
            <button
              type="button"
              onClick={() => setEditing(true)}
              // 44px to tap, pulled back in so the line keeps its height
              className="-my-2 flex min-h-11 max-w-full items-center text-xl leading-tight font-semibold tracking-tight text-white transition-colors hover:text-white/80 lg:text-2xl"
            >
              <span className="truncate">{displayName}</span>
            </button>
          </h1>
          {vipBadge && (
            <Image
              src="/images/app/vip-badge.webp"
              alt=""
              aria-hidden
              width={761}
              height={360}
              className="h-5 w-auto shrink-0"
            />
          )}
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
          {handle && (
            <button
              type="button"
              onClick={() => void copyHandle()}
              className={CHIP}
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
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={CHIP}
          >
            <Pencil className="h-3 w-3" aria-hidden />
            Edit
          </button>
        </div>
      </div>

      <EditProfileModal
        open={editing}
        onClose={() => setEditing(false)}
        displayName={displayName}
        username={username}
        handle={handle}
        avatarUrl={shownAvatar}
        onAvatarPicked={setPickedAvatar}
        frames={frames}
        highestLevel={highestLevel}
      />
    </div>
  );
}
