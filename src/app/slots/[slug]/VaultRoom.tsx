'use client';

// The Vault Room stage (spec decision #1): near-black room, warm spotlight
// cone, dust motes, and a flood layer that slowly takes the pull's rarity
// color (decision #5). Pure backdrop — all layers transform/opacity only.
import { type CSSProperties } from 'react';
import { cn } from '@/lib/utils';

const WARM = '255, 214, 150'; // warm spotlight rgb

export function VaultRoom({
  floodRgb,
  dimmed,
  reduced,
  children,
}: {
  floodRgb: string | null;
  dimmed: boolean;
  reduced: boolean;
  children: React.ReactNode;
}) {
  const rgb = floodRgb ?? WARM;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-neutral-950">
      {/* spotlight cone */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0',
          !reduced && 'transition-opacity duration-[1200ms] ease-in-out',
        )}
        style={
          {
            background: `radial-gradient(ellipse 70% 55% at 50% 8%, rgba(${rgb}, 0.16), transparent 65%)`,
            opacity: dimmed ? 0.5 : 1,
          } as CSSProperties
        }
      />
      {/* rarity flood wash (fades in from the payline outward) */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0',
          !reduced && 'transition-opacity duration-[1200ms] ease-in-out',
        )}
        style={
          {
            background: `radial-gradient(ellipse 90% 70% at 50% 50%, rgba(${rgb}, 0.22), rgba(${rgb}, 0.05) 55%, transparent 75%)`,
            opacity: floodRgb ? 1 : 0,
          } as CSSProperties
        }
      />
      {/* vignette */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.75)_100%)]"
      />
      {/* dust motes — 6 tiny dots on slow keyframe drift; hidden reduced */}
      {!reduced && (
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className="absolute h-[2px] w-[2px] rounded-full bg-amber-100/25 animate-[vault-dust_var(--dust-dur)_linear_infinite]"
              style={
                {
                  left: `${18 + i * 12}%`,
                  top: `${10 + (i % 3) * 9}%`,
                  '--dust-dur': `${9 + i * 2.4}s`,
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
