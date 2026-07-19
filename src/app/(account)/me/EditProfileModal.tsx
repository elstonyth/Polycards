'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Camera, Lock, X } from 'lucide-react';
import { FramedAvatar } from '@/components/FramedAvatar';
import { AnimatedFrame } from '@/components/AnimatedFrame';
import { AvatarCropper } from '@/components/account/AvatarCropper';
import { FRAME_LEVELS } from '@/lib/frame-levels';
import { uploadAvatar, setAvatarFrame } from '@/lib/actions/profile-appearance';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useEquippedFrame } from './equipped-frame';

/**
 * Edit Profile — opened by tapping the avatar or the name on /me (the Show
 * pattern the operator asked for, 2026-07-19). Photo and frames live together
 * here because they're one decision: the frame rings the photo.
 *
 * Everything applies immediately (no Save button): the photo POSTs after the
 * crop, a frame POSTs on tap and updates the header through the shared
 * equipped-frame context.
 *
 * ponytail: no "Choose Avatar" tab — Polycards has no preset-avatar catalog to
 * put in one. Add tabs when preset avatars exist.
 */
export function EditProfileModal({
  open,
  onClose,
  displayName,
  handle,
  avatarUrl,
  frames,
  highestLevel,
}: {
  open: boolean;
  onClose: () => void;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  frames: Record<string, string>;
  /** null = the VIP read failed — show "couldn't load", never "locked". */
  highestLevel: number | null;
}) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [frameBusy, setFrameBusy] = useState<number | 'unequip' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { equipped, setEquipped } = useEquippedFrame();

  // The cropper overlay renders above this panel and owns focus while it's up,
  // so hand the trap over rather than yanking Tab back down here.
  useModalA11y(panelRef, open && !picked, onClose);

  const initial = (displayName[0] ?? '?').toUpperCase();
  const equippedFrameUrl = equipped ? (frames[String(equipped)] ?? null) : null;

  // Self-heal a failed VIP read once (same bounded retry the frames card had):
  // the store-read burst window is 10s, so a refresh just past it usually
  // succeeds. Only while the modal is open — a closed modal shouldn't refetch.
  const levelUnknown = highestLevel === null;
  useEffect(() => {
    if (!open || !levelUnknown) return;
    const id = window.setTimeout(() => router.refresh(), 12_000);
    return () => window.clearTimeout(id);
  }, [open, levelUnknown, router]);

  function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    // Reset the input so re-picking the same file still fires onChange.
    if (fileRef.current) fileRef.current.value = '';
    if (!file || busy) return;
    setError(null);
    setPicked(file);
  }

  async function uploadCropped(cropped: File) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('file', cropped);
    try {
      const res = await uploadAvatar(form);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      // ALWAYS drop the cropper — it's a full-screen overlay above this panel,
      // so leaving it up on failure hides the error banner and reproduces the
      // exact silent failure this whole change exists to fix.
      setPicked(null);
      setBusy(false);
    }
  }

  async function handleFrame(level: number | null) {
    if (frameBusy) return;
    setFrameBusy(level === null ? 'unequip' : level);
    setError(null);
    try {
      const res = await setAvatarFrame(level);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // No router.refresh(): the POST persisted it; render from shared state.
      setEquipped(level);
    } catch {
      setError('Couldn’t update the frame. Please try again.');
    } finally {
      setFrameBusy(null);
    }
  }

  if (!open) return null;

  return (
    <>
      {createPortal(
        <div className="fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-4">
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-black/60"
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Edit profile"
            tabIndex={-1}
            className="relative z-10 max-h-[88vh] w-full overflow-y-auto rounded-t-3xl border-t border-white/10 bg-neutral-900 p-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] outline-none sm:max-w-sm sm:rounded-2xl sm:border sm:pb-6"
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-2.5 top-2.5 flex h-11 w-11 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/5 hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>

            <h2 className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
              Edit profile
            </h2>

            <div className="mt-4 flex flex-col items-center">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                aria-label="Change profile photo"
                className="group relative rounded-full outline-offset-4 disabled:opacity-60"
              >
                <FramedAvatar
                  src={avatarUrl}
                  initial={initial}
                  frameSrc={equippedFrameUrl}
                  animateLevel={equipped}
                  size={104}
                />
                <span className="absolute bottom-0 right-0 flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-neutral-800 text-white transition-colors group-hover:bg-neutral-700">
                  <Camera className="h-4 w-4" aria-hidden />
                </span>
              </button>
              <input
                ref={fileRef}
                type="file"
                // image/* (not a MIME allowlist): iOS hands back a converted
                // JPEG for HEIC library photos only when the input accepts
                // images broadly — an explicit list greyed those photos out.
                accept="image/*"
                className="hidden"
                onChange={pickFile}
              />
              <p className="mt-3 text-center text-[15px] font-semibold text-white">
                {displayName}
              </p>
              {handle && (
                <p className="text-[12px] text-neutral-500">@{handle}</p>
              )}
              <p className="mt-1 text-[12px] text-neutral-400">
                {busy ? 'Uploading…' : 'Tap the photo to change it'}
              </p>
            </div>

            {error && (
              <p
                role="alert"
                className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300"
              >
                {error}
              </p>
            )}

            <div className="mt-6 flex items-baseline justify-between">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
                Frames
              </p>
              {equipped && (
                <button
                  type="button"
                  onClick={() => void handleFrame(null)}
                  disabled={frameBusy !== null}
                  className="text-[12px] font-semibold text-white/70 underline-offset-2 hover:text-white hover:underline disabled:opacity-60"
                >
                  {frameBusy === 'unequip' ? 'Removing…' : 'Unequip'}
                </button>
              )}
            </div>
            <p className="mt-1 text-[12px] text-neutral-400">
              Unlock a new frame every 10 VIP levels.
            </p>

            {levelUnknown && (
              <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] font-medium text-amber-300">
                Couldn&rsquo;t load your VIP level, so frames can&rsquo;t be
                changed right now — your unlocks are safe. Retrying
                automatically&hellip;{' '}
                <button
                  type="button"
                  onClick={() => router.refresh()}
                  className="font-semibold underline underline-offset-2 hover:text-amber-100"
                >
                  Try again now
                </button>
              </p>
            )}

            <ul className="mt-4 grid grid-cols-4 gap-3">
              {FRAME_LEVELS.map((level) => {
                const url = frames[String(level)] ?? null;
                // Unknown level (failed read) is NOT "locked": no padlock, just
                // temporarily not equippable.
                const unlocked = highestLevel !== null && highestLevel >= level;
                const locked = highestLevel !== null && highestLevel < level;
                const isEquipped = equipped === level;
                const equippable = unlocked && url !== null && !isEquipped;
                return (
                  <li key={level} className="flex flex-col items-center gap-1">
                    <button
                      type="button"
                      disabled={!equippable || frameBusy !== null}
                      onClick={() => void handleFrame(level)}
                      aria-label={
                        isEquipped
                          ? `LV ${level} frame (equipped)`
                          : unlocked
                            ? `Equip LV ${level} frame`
                            : locked
                              ? `LV ${level} frame (unlocks at level ${level})`
                              : `LV ${level} frame (level unavailable right now)`
                      }
                      className={`relative flex h-14 w-14 items-center justify-center rounded-full border p-1 transition-colors ${
                        isEquipped
                          ? 'border-chase bg-chase/10'
                          : equippable
                            ? 'border-white/15 bg-neutral-800 hover:border-white/40'
                            : 'border-white/5 bg-neutral-900'
                      } disabled:cursor-not-allowed`}
                    >
                      {url ? (
                        unlocked || isEquipped ? (
                          // Unlocked art is alive in the workbook too (static
                          // fallback lives inside AnimatedFrame).
                          <AnimatedFrame
                            frameSrc={url}
                            level={level}
                            size={46}
                            plain
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={url}
                            alt=""
                            aria-hidden
                            className={`max-h-full max-w-full object-contain ${
                              locked ? 'opacity-30 grayscale' : 'opacity-50'
                            }`}
                          />
                        )
                      ) : (
                        <span className="text-[10px] text-neutral-500">
                          soon
                        </span>
                      )}
                      {locked && (
                        <Lock
                          className="absolute h-4 w-4 text-neutral-400"
                          aria-hidden
                        />
                      )}
                    </button>
                    <span
                      className={`text-[10px] font-semibold ${isEquipped ? 'text-chase' : 'text-neutral-500'}`}
                    >
                      {isEquipped ? 'Equipped' : `LV ${level}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>,
        document.body,
      )}
      {picked && (
        <AvatarCropper
          file={picked}
          busy={busy}
          onCancel={() => setPicked(null)}
          onConfirm={(cropped) => void uploadCropped(cropped)}
        />
      )}
    </>
  );
}
