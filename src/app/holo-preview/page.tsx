import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { HoloIcon } from '@/components/holo-3d/HoloIcon';
import type { HoloKind } from '@/components/holo-3d/holo-pose';
import { homePreviewOn } from '@/lib/preview-switch';

const KINDS: HoloKind[] = ['crown', 'gift', 'vault'];

/** The three live 3D icons on one page, large and small: a look-and-try
 *  board, served only where the preview switch is on. */
export default async function HoloPreviewPage() {
  await connection();
  if (!homePreviewOn()) notFound();
  return (
    <main className="mx-auto flex min-h-svh max-w-5xl flex-col gap-10 bg-neutral-950 px-4 py-10">
      <div className="grid gap-4 sm:grid-cols-3">
        {KINDS.map((kind) => (
          <div
            key={kind}
            data-holo={kind}
            className="rounded-3xl border border-white/10 bg-neutral-900 p-4"
          >
            <HoloIcon kind={kind} cage className="w-full" />
          </div>
        ))}
      </div>
      <div className="flex items-end gap-6" data-holo="small">
        {KINDS.map((kind) => (
          <HoloIcon key={kind} kind={kind} className="w-32" />
        ))}
      </div>
    </main>
  );
}
