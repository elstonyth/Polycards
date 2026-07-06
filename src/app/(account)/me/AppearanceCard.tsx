'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, Lock } from 'lucide-react';
import { FramedAvatar } from '@/components/FramedAvatar';
import { uploadAvatar, setAvatarFrame } from '@/lib/actions/profile-appearance';

const FRAME_LEVELS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

/**
 * Profile header + appearance controls on /me: tap the avatar (or the button)
 * to change the photo; the grid below equips/unequips milestone frames.
 * Locked frames show their unlock level. Server actions revalidate /me, so a
 * router.refresh() after each success re-renders with fresh metadata.
 */
export function AppearanceCard({
  displayName,
  subtitle,
  avatarUrl,
  equippedLevel,
  highestLevel,
  frames,
}: {
  displayName: string;
  subtitle: string;
  avatarUrl: string | null;
  equippedLevel: number | null;
  highestLevel: number;
  frames: Record<string, string>;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'photo' | number | 'unequip' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initial = (displayName[0] ?? '?').toUpperCase();
  const equippedFrameUrl = equippedLevel
    ? (frames[String(equippedLevel)] ?? null)
    : null;

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file || busy) return;
    setBusy('photo');
    setError(null);
    const form = new FormData();
    form.append('file', file);
    const res = await uploadAvatar(form);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  async function handleFrame(level: number | null) {
    if (busy) return;
    setBusy(level === null ? 'unequip' : level);
    setError(null);
    const res = await setAvatarFrame(level);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-4">
      {/* Header: framed avatar + identity */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy === 'photo'}
          aria-label="Change profile photo"
          className="group relative rounded-full outline-offset-4 disabled:opacity-60"
        >
          <FramedAvatar
            src={avatarUrl}
            initial={initial}
            frameSrc={equippedFrameUrl}
            size={72}
          />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-white/20 bg-neutral-800 text-white transition-colors group-hover:bg-neutral-700">
            <Camera className="h-3.5 w-3.5" aria-hidden />
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          className="hidden"
          onChange={(e) => void handleFile(e)}
        />
        <div className="min-w-0">
          <h1 className="font-heading truncate text-2xl text-white">
            {displayName}
          </h1>
          <p className="mt-0.5 truncate text-[13px] text-neutral-400">
            {subtitle}
          </p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy === 'photo'}
            className="mt-1 text-[12px] font-semibold text-white/70 underline-offset-2 hover:text-white hover:underline disabled:opacity-60"
          >
            {busy === 'photo' ? 'Uploading…' : 'Change photo'}
          </button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300"
        >
          {error}
        </p>
      )}

      {/* Frames */}
      <div className="rounded-2xl border border-white/10 bg-neutral-900 p-5">
        <div className="flex items-baseline justify-between">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
            Frames
          </p>
          {equippedLevel && (
            <button
              type="button"
              onClick={() => void handleFrame(null)}
              disabled={busy !== null}
              className="text-[12px] font-semibold text-white/70 underline-offset-2 hover:text-white hover:underline disabled:opacity-60"
            >
              {busy === 'unequip' ? 'Removing…' : 'Unequip'}
            </button>
          )}
        </div>
        <p className="mt-1 text-[12px] text-neutral-400">
          Unlock a new frame every 10 VIP levels.
        </p>
        <ul className="mt-4 grid grid-cols-5 gap-3">
          {FRAME_LEVELS.map((level) => {
            const url = frames[String(level)] ?? null;
            const unlocked = highestLevel >= level;
            const equipped = equippedLevel === level;
            const equippable = unlocked && url !== null && !equipped;
            return (
              <li key={level} className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  disabled={!equippable || busy !== null}
                  onClick={() => void handleFrame(level)}
                  aria-label={
                    equipped
                      ? `LV ${level} frame (equipped)`
                      : unlocked
                        ? `Equip LV ${level} frame`
                        : `LV ${level} frame (unlocks at level ${level})`
                  }
                  className={`relative flex h-14 w-14 items-center justify-center rounded-full border p-1 transition-colors ${
                    equipped
                      ? 'border-chase bg-chase/10'
                      : equippable
                        ? 'border-white/15 bg-neutral-800 hover:border-white/40'
                        : 'border-white/5 bg-neutral-900'
                  } disabled:cursor-not-allowed`}
                >
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={url}
                      alt=""
                      aria-hidden
                      className={`max-h-full max-w-full object-contain ${unlocked ? '' : 'opacity-30 grayscale'}`}
                    />
                  ) : (
                    <span className="text-[10px] text-neutral-500">soon</span>
                  )}
                  {!unlocked && (
                    <Lock
                      className="absolute h-4 w-4 text-neutral-400"
                      aria-hidden
                    />
                  )}
                </button>
                <span
                  className={`text-[10px] font-semibold ${equipped ? 'text-chase' : 'text-neutral-500'}`}
                >
                  {equipped ? 'Equipped' : `LV ${level}`}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
