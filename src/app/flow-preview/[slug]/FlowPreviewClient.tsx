'use client';

// TEMPORARY (WP-F flow groundwork): remove with ./page.tsx at integration.

import { FlowChapters } from '@/components/pack-flow/FlowChapters';
import {
  useFlowAddress,
  type FlowAddress,
} from '@/components/pack-flow/flow-address';
import { useFlowData } from '@/components/pack-flow/use-flow-data';
import type { FlowSeed } from '@/components/pack-flow/types';
import { rm } from '@/lib/format';

/** One focused pack: its live data, then the chapters with the stand-in. */
function FocusedPack({
  seed,
  address,
  autoFocusHeading,
}: {
  seed: FlowSeed;
  address: FlowAddress;
  autoFocusHeading: boolean;
}) {
  const data = useFlowData(seed);
  return (
    <FlowChapters
      key={seed.pack.id}
      data={data}
      onLeave={address.leave}
      onGoToReel={address.enterReel}
      entryId={address.entryId}
      autoFocusHeading={autoFocusHeading}
    />
  );
}

/** The homepage carousel's stand-in: one tile per pack, a tap focuses it. */
function StandInStage({
  seeds,
  address,
}: {
  seeds: FlowSeed[];
  address: FlowAddress;
}) {
  return (
    <section className="px-fluid py-10" aria-label="Packs">
      <h1 className="font-heading text-4xl font-bold tracking-tight text-white">
        Flow preview
      </h1>
      <p className="mt-2 text-sm text-neutral-400">
        A stand-in for the homepage stage: tap a pack to focus it.
      </p>
      <ul className="mt-8 flex gap-4 overflow-x-auto pb-4">
        {seeds.map((s) => (
          <li key={s.pack.id} className="w-40 shrink-0">
            <a
              href={`/slots/${s.pack.id}`}
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey)
                  return;
                e.preventDefault();
                window.scrollTo(0, 0);
                address.enter(s.pack.id);
              }}
              className="flex flex-col items-center gap-2 rounded-2xl bg-white/[0.04] p-3 text-center ring-1 ring-white/10 hover:bg-white/[0.07]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- stand-in tile */}
              <img
                src={s.pack.image}
                alt=""
                className="h-40 w-auto object-contain"
              />
              <span className="text-sm font-semibold text-white">
                {s.pack.name}
              </span>
              <span className="text-xs text-neutral-400">
                {rm(s.pack.priceMyr)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function FlowPreviewClient({
  mode,
  basePath,
  seeds,
}: {
  mode: 'pack' | 'stage';
  basePath: string;
  seeds: FlowSeed[];
}) {
  const address = useFlowAddress(basePath);
  if (mode === 'pack') {
    return (
      <FocusedPack
        seed={seeds[0]!}
        address={address}
        autoFocusHeading={false}
      />
    );
  }
  const focused =
    address.location.kind === 'focus'
      ? seeds.find(
          (s) =>
            address.location.kind === 'focus' &&
            s.pack.id === address.location.id,
        )
      : undefined;
  return focused ? (
    <FocusedPack seed={focused} address={address} autoFocusHeading />
  ) : (
    <StandInStage seeds={seeds} address={address} />
  );
}
