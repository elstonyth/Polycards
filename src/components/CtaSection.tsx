import Link from 'next/link';
import { cn } from '@/lib/utils';

const CDN = '';

type FanImage = {
  src: string;
  left: string;
  rotate: string;
  z: number;
  /** Tailwind responsive height classes */
  height: string;
};

// Decorative fan of slabs + packs at the bottom of the CTA card.
const FAN_IMAGES: FanImage[] = [
  {
    src: '/home/hero/slabs/pokemon3.webp',
    left: '8%',
    rotate: '-8deg',
    z: 2,
    height: 'h-[140px] sm:h-[190px]',
  },
  {
    src: '/images/claw/trainer-pack-icon.webp',
    left: '22%',
    rotate: '-3deg',
    z: 1,
    height: 'h-[120px] sm:h-[160px]',
  },
  {
    src: '/home/hero/slabs/pokemon1.webp',
    left: '36%',
    rotate: '4deg',
    z: 1,
    height: 'h-[100px] sm:h-[140px]',
  },
  {
    src: '/images/claw/platinum-pack-icon.webp',
    left: '50%',
    rotate: '0deg',
    z: 1,
    height: 'h-[110px] sm:h-[150px]',
  },
  {
    src: '/home/hero/slabs/pokemon3.webp',
    left: '64%',
    rotate: '-5deg',
    z: 1,
    height: 'h-[100px] sm:h-[140px]',
  },
  {
    src: '/images/claw/legend-pack-icon.webp',
    left: '78%',
    rotate: '3deg',
    z: 1,
    height: 'h-[120px] sm:h-[160px]',
  },
  {
    src: '/images/claw/mythic-pack-icon.webp',
    left: '92%',
    rotate: '7deg',
    z: 2,
    height: 'h-[140px] sm:h-[190px]',
  },
];

export default function CtaSection() {
  return (
    <div className="mt-10 sm:mt-14">
      <Link
        href="/claw"
        className={cn(
          'group relative block overflow-hidden rounded-2xl',
          'border border-white/10',
          'bg-gradient-to-b from-white/[0.07] to-white/[0.02]',
          'shadow-[0_4px_20px_rgba(0,0,0,0.25)]',
        )}
      >
        {/* Text content */}
        <div className="relative z-10 px-6 pt-10 text-center sm:pt-14">
          <h2
            className={cn(
              'font-heading text-2xl font-semibold tracking-tight md:text-3xl',
              'bg-gradient-to-b from-white via-white/90 to-white/40 bg-clip-text text-transparent',
            )}
          >
            Ready to start collecting?
          </h2>
          <p className="mx-auto mt-2 max-w-md text-[15px] text-white/50">
            Open packs, pull graded cards, and build your collection today.
          </p>
          <div className="mt-6">
            <span
              className={cn(
                'inline-flex items-center rounded-full px-7 py-3 text-sm font-semibold',
                'bg-white text-black',
                'shadow-[0_0_30px_rgba(255,255,255,0.12)]',
                'transition-shadow duration-300',
                'group-hover:shadow-[0_0_40px_rgba(255,255,255,0.2)]',
              )}
            >
              Rip a pack
            </span>
          </div>
        </div>

        {/* Decorative fanned slabs / packs.
            The rotation + horizontal centering live on a wrapper (inline transform),
            and the hover-lift lives on the <img> as a Tailwind group-hover class.
            Splitting them onto two elements avoids the inline-style vs class
            specificity conflict that would otherwise kill the hover translate. */}
        <div className="relative mt-8 flex h-[180px] items-end justify-center sm:h-[220px]">
          {FAN_IMAGES.map((img, i) => (
            <div
              key={i}
              className="absolute bottom-0"
              style={{
                left: img.left,
                transform: `translateX(-50%) rotate(${img.rotate})`,
                zIndex: img.z,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- decorative CDN card art with per-image transforms, kept raw like the hero art */}
              <img
                src={`${CDN}${img.src}`}
                alt=""
                className={cn(
                  'w-auto object-contain',
                  'drop-shadow-[0_8px_24px_rgba(0,0,0,0.5)]',
                  'transition-transform duration-500 ease-out group-hover:-translate-y-2',
                  img.height,
                )}
              />
            </div>
          ))}
        </div>
      </Link>
    </div>
  );
}
