import Image from 'next/image';
import { CAT_ICON } from '@/lib/packs-data';
import { cn } from '@/lib/utils';

/**
 * The Polycards mark (public/branding/polycards-logo.png) redrawn as line art
 * in the logo's own 54x75 grid. Straight strokes in one flat colour (the text
 * colour) replace the old chrome render, which went soft and skewed at icon
 * size and vanished into nothing like the logo.
 */
const POLY_MARK =
  // silhouette
  'M11 2.25H48A3 3 0 0 1 51 5.25V62L46.25 67L11 72.75L2.25 63V13.25Z' +
  // near vertical edge
  'M11 2.25V72.75' +
  // top band: left face, then front face
  'M2.25 13.25L11 15.5H51' +
  // bottom band: left face, then front face
  'M2.25 63L11 58.5L51 62' +
  // front-face diagonal
  'M11 54.5L46.75 15.5' +
  // bottom-face diagonal
  'M11 72.75L29 60';

export function PolyMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 54 75"
      fill="none"
      stroke="currentColor"
      strokeWidth={4.5}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={POLY_MARK} />
    </svg>
  );
}

/** True for the category whose icon is our own mark (drawn, not an image). */
export const isPolyIcon = (src: string) => src === CAT_ICON.poly;

/**
 * A category's badge icon. Franchise icons are images; Poly is our mark, drawn
 * in the surrounding text colour so it reads on the dark panel and inverts on
 * the selected (white) tab. Size the box with `className` (h-5 w-5 etc.).
 */
export default function CategoryIcon({
  src,
  size,
  className,
}: {
  src: string;
  /** The image's intrinsic size hint, in CSS px (next/image width/height). */
  size: number;
  className?: string;
}) {
  if (isPolyIcon(src)) return <PolyMark className={className} />;
  return (
    <Image
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={cn('object-contain', className)}
    />
  );
}
