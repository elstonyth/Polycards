import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import ReelPreview from '@/components/reel-3d/ReelPreview';

export const metadata: Metadata = {
  title: 'Reel preview',
  robots: { index: false, follow: false },
};

/**
 * The 3D reel with mock data. 404 unless `next dev` or the server runs with
 * REEL_PREVIEW=1. Reads no backend and no customer data.
 */
export default async function ReelPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Await the query BEFORE the gate: a notFound() reached first lets the build
  // prerender the route as a static 404, and the runtime flag is never read.
  await searchParams;
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.REEL_PREVIEW !== '1'
  ) {
    notFound();
  }
  return <ReelPreview />;
}
