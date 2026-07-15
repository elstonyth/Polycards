'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { Camera, Check, Copy, Lock } from 'lucide-react';
import { FramedAvatar } from '@/components/FramedAvatar';
import { AnimatedFrame } from '@/components/AnimatedFrame';
import { FRAME_LEVELS } from '@/lib/frame-levels';
import { uploadAvatar, setAvatarFrame } from '@/lib/actions/profile-appearance';
import { compact, num } from '@/lib/format';

/**
 * Me-page appearance pieces, split from the old AppearanceCard so the header
 * can sit at the top of the page while the frames grid lives further down
 * (Show-style layout). The equipped frame is shared through a tiny context so
 * equipping a frame still updates the header avatar instantly WITHOUT a
 * router.refresh() — the full-page refetch is what blew the per-actor read
 * budget during rapid swapping (2026-07-07 round 2).
 */

const EquippedFrameContext = createContext<{
  equipped: number | null;
  setEquipped: (level: number | null) => void;
} | null>(null);

export function EquippedFrameProvider({
  initial,
  children,
}: {
  initial: number | null;
  children: ReactNode;
}) {
  const [equipped, setEquipped] = useState(initial);
  // Server prop changed (real navigation/refresh) — resync during render,
  // the React-sanctioned pattern for prop-driven state adjustment.
  const [prev, setPrev] = useState(initial);
  if (prev !== initial) {
    setPrev(initial);
    setEquipped(initial);
  }
  return (
    <EquippedFrameContext.Provider value={{ equipped, setEquipped }}>
      {children}
    </EquippedFrameContext.Provider>
  );
}

function useEquippedFrame() {
  const ctx = useContext(EquippedFrameContext);
  if (!ctx) {
    throw new Error('useEquippedFrame requires <EquippedFrameProvider>');
  }
  return ctx;
}

/**
 * Header: framed avatar (tap to change photo), name, pull/point stats, and a
 * copyable @handle chip — the Show "Me" header adapted to Polycards data.
 */
export function MeHeader({
  displayName,
  handle,
  pulls,
  points,
  avatarUrl,
  frames,
}: {
  displayName: string;
  handle: string | null;
  /** null = profile read unavailable — the stats row is hidden. */
  pulls: number | null;
  points: number | null;
  avatarUrl: string | null;
  frames: Record<string, string>;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { equipped } = useEquippedFrame();
  const initial = (displayName[0] ?? '?').toUpperCase();
  const equippedFrameUrl = equipped ? (frames[String(equipped)] ?? null) : null;

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('file', file);
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
      setBusy(false);
    }
  }

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
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          aria-label="Change profile photo"
          className="group relative shrink-0 rounded-full outline-offset-4 disabled:opacity-60"
        >
          <FramedAvatar
            src={avatarUrl}
            initial={initial}
            frameSrc={equippedFrameUrl}
            animateLevel={equipped}
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
          {pulls !== null && points !== null && (
            <p className="mt-1 text-[13px] text-neutral-400">
              <span className="font-semibold text-white">{num(pulls)}</span>{' '}
              Pulls{' '}
              <span className="ml-2 font-semibold text-white">
                {compact(points)}
              </span>{' '}
              Points
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

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300"
        >
          {error}
        </p>
      )}
    </section>
  );
}

/** The milestone-frame grid — unchanged logic, now its own card lower on /me. */
export function FramesCard({
  highestLevel,
  frames,
}: {
  /** null = the VIP read failed — show "couldn't load", never "locked". */
  highestLevel: number | null;
  frames: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | 'unequip' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { equipped, setEquipped } = useEquippedFrame();

  // Self-heal a failed VIP read once: the store-read burst window is 10s, so
  // a refresh just past it usually succeeds. Bounded to a single retry so a
  // persistent outage isn't amplified by every open /me re-reading the whole
  // page forever — the manual "Try again now" button covers the rest.
  const levelUnknown = highestLevel === null;
  useEffect(() => {
    if (!levelUnknown) return;
    const id = window.setTimeout(() => router.refresh(), 12_000);
    return () => window.clearTimeout(id);
  }, [levelUnknown, router]);

  async function handleFrame(level: number | null) {
    if (busy) return;
    setBusy(level === null ? 'unequip' : level);
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
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-900 p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
          Frames
        </p>
        {equipped && (
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
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300"
        >
          {error}
        </p>
      )}
      {levelUnknown && (
        <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] font-medium text-amber-300">
          Couldn&rsquo;t load your VIP level, so frames can&rsquo;t be changed
          right now — your unlocks are safe. Retrying automatically&hellip;{' '}
          <button
            type="button"
            onClick={() => router.refresh()}
            className="font-semibold underline underline-offset-2 hover:text-amber-100"
          >
            Try again now
          </button>
        </p>
      )}
      <ul className="mt-4 grid grid-cols-5 gap-3">
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
                disabled={!equippable || busy !== null}
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
                  <span className="text-[10px] text-neutral-500">soon</span>
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
  );
}
