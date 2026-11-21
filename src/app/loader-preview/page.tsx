import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { homePreviewOn } from '@/lib/preview-switch';
import { LoaderPreview, type ReadyMode } from './LoaderPreview';

export const metadata: Metadata = {
  title: 'Loader preview',
  robots: { index: false, follow: false },
};

const READY_MODES: readonly ReadyMode[] = ['now', '3s', 'never'];

/**
 * Brand loader preview: 404 unless the home preview's switch is on
 * (homePreviewOn). Reading searchParams keeps the route dynamic, so the gate is
 * checked per request rather than baked in at build time.
 *
 * Query: `?t=0.5` pins the reveal at that fraction of its timeline (for stills);
 * `?ready=now|3s|never` picks when `ready` turns true.
 */
export default async function LoaderPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Await the query BEFORE the gate: a notFound() reached first lets the build
  // prerender the route as a static 404, and the runtime flag is never read.
  const query = await searchParams;
  if (!homePreviewOn()) notFound();
  const tRaw =
    typeof query.t === 'string' ? Number.parseFloat(query.t) : Number.NaN;
  const pinAt = Number.isFinite(tRaw)
    ? Math.min(1, Math.max(0, tRaw))
    : undefined;
  const readyRaw = typeof query.ready === 'string' ? query.ready : '';
  const readyMode = READY_MODES.find((mode) => mode === readyRaw) ?? 'now';
  return <LoaderPreview pinAt={pinAt} initialReadyMode={readyMode} />;
}
