'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { useSound } from '@/lib/use-sound';
import { cn } from '@/lib/utils';
import { Pill } from '@/components/ui/pill';

/**
 * The header's speaker button: a small panel with the two sound switches, so
 * the music can go while the clicks and reveals stay (or the other way round).
 *
 * A button, a panel and an outside-tap/Escape close, as HelpTip does it. The
 * panel hangs off the header's right gutter rather than the button: under a
 * button in the middle of a narrow phone's header it would run off the screen.
 * (The wrapper is `contents`, so the header stays the panel's anchor.)
 */
export function SoundMenu() {
  const { muted, soundsOff, musicOff, toggleSounds, toggleMusic } = useSound();
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // the switch that had focus is gone with the panel
      ref.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      className="contents"
      // Tabbed out of with the keyboard: closed. (A blur to nowhere is left
      // alone: Safari gives one when a switch is clicked with the mouse.)
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
          setOpen(false);
      }}
    >
      <Pill
        variant="ghost"
        className="w-11 px-0"
        aria-label={muted ? 'Sound settings (all off)' : 'Sound settings'}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title="Sound"
        onClick={() => setOpen((o) => !o)}
      >
        {muted ? (
          <VolumeX className="h-4 w-4" aria-hidden />
        ) : (
          <Volume2 className="h-4 w-4" aria-hidden />
        )}
      </Pill>
      {open && (
        <div
          id={id}
          role="group"
          aria-label="Sound"
          className="absolute top-full right-[clamp(1rem,1.6vw,4.5rem)] z-50 mt-2 w-52 rounded-2xl border border-white/10 bg-neutral-900 p-1.5 shadow-xl"
        >
          <SoundSwitch label="Music" on={!musicOff} onToggle={toggleMusic} />
          <SoundSwitch label="Sounds" on={!soundsOff} onToggle={toggleSounds} />
        </div>
      )}
    </div>
  );
}

function SoundSwitch({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className="flex min-h-11 w-full items-center justify-between gap-6 rounded-xl px-3 text-sm font-medium text-white hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
    >
      {label}
      <span
        aria-hidden
        className={cn(
          'flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors motion-reduce:transition-none',
          on ? 'bg-neutral-50' : 'bg-neutral-700',
        )}
      >
        <span
          className={cn(
            'h-5 w-5 rounded-full transition-transform motion-reduce:transition-none',
            on ? 'translate-x-4 bg-neutral-950' : 'bg-neutral-400',
          )}
        />
      </span>
    </button>
  );
}
