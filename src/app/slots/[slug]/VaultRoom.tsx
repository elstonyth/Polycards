'use client';

// The Vault Room stage (spec decision #1, lighting overhauled #40): near-black
// cinematic room, one soft ceiling spotlight, a rarity flood on reveal, a gentle
// vignette, and a fine GRAIN overlay that dithers the gradients so they never
// band into visible rings on wide/desktop viewports. Pure backdrop — all layers
// transform/opacity only.
import { type CSSProperties } from 'react';
import { cn } from '@/lib/utils';

const WARM = '255, 214, 150'; // warm spotlight rgb

// Fine film grain (SVG fractalNoise) tiled over the whole room. A low-opacity
// NORMAL-blend overlay dithers 8-bit banding on the dark gradients — the
// standard cinematic-dark-scene trick. (Normal blend, NOT mix-blend-mode:
// overlay — a blend-mode layer over the animating reels re-composites the
// whole viewport every frame and doubled our p95 frame time.)
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

export function VaultRoom({
  floodRgb,
  dimmed,
  reduced,
  tension = false,
  children,
}: {
  floodRgb: string | null;
  dimmed: boolean;
  reduced: boolean;
  tension?: boolean;
  children: React.ReactNode;
}) {
  const rgb = floodRgb ?? WARM;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-neutral-950">
      {/* Ceiling spotlight — anchored top-center, MANY soft stops so no ring
          edge is ever visible. Warm when idle, rarity color during reveal. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0',
          !reduced && 'transition-opacity duration-[1200ms] ease-in-out',
        )}
        style={
          {
            background: `radial-gradient(130% 95% at 50% -5%, rgba(${rgb}, 0.15) 0%, rgba(${rgb}, 0.09) 16%, rgba(${rgb}, 0.05) 30%, rgba(${rgb}, 0.02) 46%, transparent 68%)`,
            opacity: dimmed ? 0.55 : 1,
          } as CSSProperties
        }
      />
      {/* Rarity flood wash (reveal only) — soft, centered on the prize. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0',
          !reduced && 'transition-opacity duration-[1200ms] ease-in-out',
        )}
        style={
          {
            background: `radial-gradient(85% 70% at 50% 46%, rgba(${rgb}, 0.20) 0%, rgba(${rgb}, 0.11) 28%, rgba(${rgb}, 0.05) 48%, rgba(${rgb}, 0.015) 64%, transparent 80%)`,
            opacity: floodRgb ? 1 : 0,
          } as CSSProperties
        }
      />
      {/* Vignette — tightens + pushes in during rising tension. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0',
          !reduced && 'transition-transform duration-700 ease-out',
        )}
        style={{
          background: tension
            ? 'radial-gradient(115% 100% at 50% 42%, transparent 38%, rgba(0,0,0,0.35) 66%, rgba(0,0,0,0.62) 88%, rgba(0,0,0,0.78) 100%)'
            : 'radial-gradient(135% 115% at 50% 40%, transparent 52%, rgba(0,0,0,0.22) 74%, rgba(0,0,0,0.45) 90%, rgba(0,0,0,0.6) 100%)',
          transform: tension && !reduced ? 'scale(1.04)' : 'scale(1)',
        }}
      />
      {/* Grain dither — kills gradient banding. Static, cheap (one paint,
          normal blend, no per-frame recomposite). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{ backgroundImage: GRAIN, backgroundSize: '140px 140px' }}
      />
      {/* dust motes — 3 faint dots on slow drift; hidden under reduced motion */}
      {!reduced && (
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {Array.from({ length: 3 }, (_, i) => (
            <span
              key={i}
              className="absolute h-px w-px rounded-full bg-amber-100/15 animate-[vault-dust_var(--dust-dur)_linear_infinite]"
              style={
                {
                  left: `${34 + i * 16}%`,
                  top: `${14 + (i % 3) * 8}%`,
                  '--dust-dur': `${12 + i * 3}s`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}
