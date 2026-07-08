import Image from 'next/image';
import { cn } from '@/lib/utils';
import { AnimatedFrame } from '@/components/AnimatedFrame';

/**
 * Framed avatar — profile photo (or an initial-letter circle when there is no
 * photo) with an optional unlocked-frame overlay. The photo is a plain <img>
 * (leaderboard-style — pfp art and uploaded photos are tiny); the frame overlay
 * is next/image (sizes-scoped). Both are server-and-client safe. The frame
 * layers ABOVE the photo and bleeds
 * ~28% past it so ring-style frames read as surrounding the picture. A null
 * frameSrc renders photo-only — a removed catalog entry must never 404.
 *
 * `animateLevel` opts the frame into the WebGL motion shader (big avatars
 * only — /me header, public profile; grids/leaderboards stay static). The
 * static frame remains the fallback whenever the shader can't run.
 */
export function FramedAvatar({
  src,
  initial = '?',
  frameSrc = null,
  size,
  alt = '',
  className,
  priority = false,
  animateLevel = null,
}: {
  src: string | null;
  initial?: string;
  frameSrc?: string | null;
  size: number;
  alt?: string;
  className?: string;
  /** Eager-load — set on above-the-fold avatars (profile header = LCP). */
  priority?: boolean;
  /** Milestone level of the equipped frame — enables the animated shader. */
  animateLevel?: number | null;
}) {
  return (
    <span
      className={cn('relative inline-block shrink-0', className)}
      style={{ width: size, height: size }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          width={size}
          height={size}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="font-heading flex h-full w-full items-center justify-center rounded-full bg-neutral-800 text-neutral-50"
          style={{ fontSize: Math.round(size * 0.4) }}
        >
          {initial}
        </span>
      )}
      {frameSrc &&
        (animateLevel ? (
          <AnimatedFrame frameSrc={frameSrc} level={animateLevel} size={size} />
        ) : (
          <Image
            src={frameSrc}
            alt=""
            aria-hidden
            width={size}
            height={size}
            sizes={`${Math.ceil(size * 1.28)}px`}
            loading={priority ? 'eager' : 'lazy'}
            className="pointer-events-none absolute left-1/2 top-1/2 h-[128%] w-[128%] max-w-none -translate-x-1/2 -translate-y-1/2 object-contain"
          />
        ))}
    </span>
  );
}
