import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { Rarity } from '@/lib/packs-data';
import { RARITY_ORDER } from '@/lib/rarity';
import ReelPreview, {
  type SeekProps,
} from '@/components/reel-3d-prototype/ReelPreview';
import { VARIANTS, type Variant } from '@/components/reel-3d-prototype/layouts';

export const metadata: Metadata = {
  title: 'Reel preview',
  robots: { index: false, follow: false },
};

/**
 * PROTOTYPE, throwaway: four looks for the reel, switched with ?variant=
 * (today|a|b|c, default a). 404 unless `next dev` or the server runs with
 * REEL_PREVIEW=1. Reads no backend and no customer data.
 *
 * `?debug=1` shows a readout. `?t=<ms>&seed=<n>&win=<Rarity>&reels=<1-3>`
 * freezes a 3D look at t ms after a press, with a deterministic strip.
 */
export default async function ReelPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Await the query BEFORE the gate: a notFound() reached first lets the build
  // prerender the route as a static 404, and the runtime flag is never read.
  const query = await searchParams;
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.REEL_PREVIEW !== '1'
  ) {
    notFound();
  }
  const one = (key: string) =>
    typeof query[key] === 'string' ? (query[key] as string) : '';
  const variant: Variant = VARIANTS.find((v) => v === one('variant')) ?? 'a';
  const reels = Math.min(3, Math.max(1, Number(one('reels')) || 1));
  const win = RARITY_ORDER.find((r) => r === one('win')) ?? null;
  const seek: SeekProps | null =
    one('t') !== '' && Number.isFinite(Number(one('t')))
      ? {
          t: Number(one('t')),
          seed: Number(one('seed')) || 1,
          win: win as Rarity | null,
          reels,
        }
      : null;
  return (
    <ReelPreview
      initialVariant={variant}
      debug={one('debug') === '1'}
      seek={seek}
      initialReels={reels}
    />
  );
}
