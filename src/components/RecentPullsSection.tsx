'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { RecentPull } from '@/lib/data/packs';

// Helper to build the real phygitals CDN card-image URL (localized webp).
const cardImg = (id: string) =>
  `/cdn/cards/${id.replace(/[^\w.-]/g, '_')}.webp`;

const ROOKIE_ICON = '/images/claw/rookie-pack-icon.webp';
const ELITE_ICON = '/images/claw/elite-pack-icon.webp';

// Static fallback — real extracted pulls from phygitals.com. Used when the live
// ledger is empty or the backend is down, so the home section stays populated.
const MOCK_PULLS: RecentPull[] = [
  {
    id: 'm1',
    name: '2021 Pokemon Japanese Sword & Shield Jet-Black Spirit Celebi V #3 CGC 10 GEM MINT',
    image: cardImg('FQEYWuGiKTkJpZSG6XqGHDBmH6EmxctEqk1kAT2MYzHc'),
    value: '',
    rarity: 'Legendary',
    packName: 'Rookie Pack',
    packIcon: ROOKIE_ICON,
    agoLabel: '1m ago',
  },
  {
    id: 'm2',
    name: '2025 Pokemon Japanese SV Glory Of Rocket Gang Holo Team Rockets Mewtwo ex CGC 10',
    image: cardImg('9kRLkdbbvzm335GBvraQrWrNVs72gzEzynvP1RPvftTx'),
    value: '',
    rarity: 'Epic',
    packName: 'Rookie Pack',
    packIcon: ROOKIE_ICON,
    agoLabel: '6m ago',
  },
  {
    id: 'm3',
    name: '2023 Pokemon Sword and Shield Crown Zenith Galarian Gallery Darkrai Vstar #GG50 PSA 10',
    image: cardImg('4h13RDtFX4MWNYjvgMPeBS1hcL4AewupiFzDvyFUUTkd'),
    value: '',
    rarity: 'Epic',
    packName: 'Elite Pack',
    packIcon: ELITE_ICON,
    agoLabel: '15m ago',
  },
  {
    id: 'm4',
    name: '2024 Pokemon Japanese Scarlet & Violet Terastal Fest ex Holo Jolteon ex #52 CGC 10 PRISTINE',
    image: cardImg('BEnddEeBXBHyL5qWXCg6sKS5VmUbUtZaKJ1aVB8yCWHN'),
    value: '',
    rarity: 'Rare',
    packName: 'Elite Pack',
    packIcon: ELITE_ICON,
    agoLabel: '15m ago',
  },
  {
    id: 'm5',
    name: '2025 Pokemon Japanese Mega Start Deck 100 Battle Collection Reverse Holo Rapidash #90 CGC 10',
    image: cardImg('FFbo5jfXHHQWN8bmc88UDYSDP5QzYCCj6RwUkiWYyffC'),
    value: '',
    rarity: 'Common',
    packName: 'Rookie Pack',
    packIcon: ROOKIE_ICON,
    agoLabel: '16m ago',
  },
  {
    id: 'm6',
    name: '2022 Pokemon Japanese Sword & Shield Incandescent Arcana Ho-Oh V #55 CGC 10 GEM MINT',
    image: cardImg('FjAJZ7en585MpnoLUGbuALHEmbBAPd61EZCefQzFMmRX'),
    value: '',
    rarity: 'Rare',
    packName: 'Rookie Pack',
    packIcon: ROOKIE_ICON,
    agoLabel: '16m ago',
  },
  {
    id: 'm7',
    name: '2023 Pokemon Japanese Scarlet & Violet 151 Holo Gengar #94 CGC 10 GEM MINT',
    image: cardImg('6noxMybjBLtLqicAUTrG63VhWG2FgWzDBsQGnnZEyNCG'),
    value: '',
    rarity: 'Epic',
    packName: 'Rookie Pack',
    packIcon: ROOKIE_ICON,
    agoLabel: '16m ago',
  },
];

const POLL_MS = 12000;

function PullCard({ pull }: { pull: RecentPull }) {
  return (
    <div
      className={cn(
        'group/card w-[240px] shrink-0 overflow-hidden rounded-2xl',
        'border border-neutral-700 bg-neutral-800',
        'transition-all duration-300 ease-out',
        'hover:-translate-y-1 hover:border-neutral-500 hover:shadow-xl hover:shadow-black/40',
      )}
    >
      <div className="flex flex-col">
        {/* Card image on a dark pedestal / spotlight backdrop */}
        <div className="relative aspect-square w-full overflow-hidden bg-[radial-gradient(120%_80%_at_50%_15%,#2e2e2e_0%,#1c1c1c_55%,#141414_100%)]">
          {/* Xm ago badge, top-right */}
          <span className="absolute right-2 top-2 z-10 rounded-full border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
            {pull.agoLabel}
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pull.image}
            alt={pull.name}
            width={238}
            height={238}
            loading="lazy"
            className="h-full w-full object-contain p-4 transition-transform duration-300 ease-out group-hover/card:scale-[1.04]"
          />
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 p-3">
          <p className="line-clamp-2 min-h-[40px] text-sm font-bold leading-5 text-white">
            {pull.name}
          </p>
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pull.packIcon}
              alt={pull.packName}
              width={28}
              height={28}
              loading="lazy"
              className="h-7 w-7 shrink-0 object-contain"
            />
            <div className="flex flex-col leading-tight">
              <span className="text-xs font-medium text-white">
                {pull.packName}
              </span>
              <span className="text-[10px] font-medium text-neutral-400">
                Just revealed
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function RecentPullsSection({
  initialPulls,
}: {
  /** Live recent pulls (server-fetched); falls back to the static mock set. */
  initialPulls?: RecentPull[];
}) {
  const [pulls, setPulls] = useState<RecentPull[]>(
    initialPulls && initialPulls.length ? initialPulls : MOCK_PULLS,
  );

  // Live feed — poll the same-origin proxy (a direct :9000 call is CORS-blocked)
  // and swap in fresh ledger pulls. Keeps the last good set on error/empty so the
  // row never blanks out.
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const res = await fetch('/api/recent-pulls', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { pulls?: RecentPull[] };
        if (active && Array.isArray(data.pulls) && data.pulls.length > 0) {
          setPulls(data.pulls);
        }
      } catch {
        // keep the current set on a transient failure
      }
    };
    void tick(); // swap in live data immediately, then keep polling
    const id = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return (
    <section className="w-full bg-neutral-950 py-16 sm:py-20">
      <div className="mx-auto w-full">
        {/* Header */}
        <div className="mx-auto mb-10 flex max-w-2xl flex-col items-center text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-white/45">
            Live from the claw
          </p>
          <h2 className="font-heading mt-1.5 bg-gradient-to-b from-white to-neutral-400 bg-clip-text text-2xl font-bold leading-tight tracking-tight text-transparent md:text-3xl">
            Recent Pulls
          </h2>
          <p className="mt-1.5 text-sm text-neutral-400">
            See what collectors are pulling right now.
          </p>
        </div>

        {/* Horizontally-scrollable row of pulled-card cards */}
        <div
          className={cn(
            'flex gap-4 overflow-x-auto pb-4',
            '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
            'snap-x snap-mandatory scroll-px-4',
          )}
        >
          {pulls.map((pull) => (
            <div key={pull.id} className="snap-start">
              <PullCard pull={pull} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
