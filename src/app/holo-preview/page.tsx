import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { HoloIcon } from '@/components/holo-3d/HoloIcon';
import type { HoloKind, HoloTone } from '@/components/holo-3d/holo-pose';
import { homePreviewOn } from '@/lib/preview-switch';

const KINDS: HoloKind[] = ['crown', 'gift', 'vault'];
// The metal finishes in use: the podium's crowns, the check-in gifts.
const METALS: [HoloKind, HoloTone][] = [
  ['crown', 'gold'],
  ['crown', 'silver'],
  ['crown', 'bronze'],
  ['gift', 'gold'],
];

/** Every live 3D icon in use on one page: a look-and-try board, served only
 *  where the preview switch is on. scripts/capture-holo-posters.mjs saves
 *  each `data-poster` box's canvas as the poster of that name. */
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
            data-poster={`${kind}-cage`}
            className="rounded-3xl border border-white/10 bg-neutral-900 p-4"
          >
            <HoloIcon kind={kind} cage className="w-full" />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-6" data-holo="small">
        {KINDS.map((kind) => (
          <div key={kind} data-poster={kind}>
            <HoloIcon kind={kind} className="w-32" />
          </div>
        ))}
        {METALS.map(([kind, tone]) => (
          <div key={`${kind}-${tone}`} data-poster={`${kind}-${tone}`}>
            <HoloIcon kind={kind} tone={tone} className="w-32" />
          </div>
        ))}
      </div>
    </main>
  );
}
