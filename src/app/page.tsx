import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight, BadgeCheck, Banknote, Vault } from 'lucide-react';
import {
  getPackCategories,
  getPackDetail,
  getRecentPulls,
} from '@/lib/data/packs';
import { priceNumber, type Pack, type PackCard } from '@/lib/packs-data';
import { priceTier, TIER_COLOR } from '@/lib/price-tier';
import RecentPullsSection from '@/components/RecentPullsSection';

// Pack catalog + live pulls come fresh from the backend on every request.
export const dynamic = 'force-dynamic';

/** How many pack tiles get a per-pack top-chase lookup (one request each). */
const CHASE_LOOKUPS = 8;

export default async function HomePage() {
  const [categories, pulls] = await Promise.all([
    getPackCategories(),
    getRecentPulls(),
  ]);
  const packs = categories.flatMap((c) => c.packs);
  const inStock = packs.filter((p) => p.inStock !== false);
  const featured = [...inStock].sort(
    (a, b) => priceNumber(b.price) - priceNumber(a.price),
  )[0];

  // Chase lookups cover the first N tiles PLUS the featured pack, so the hero
  // never silently loses its chase when featured falls outside the first N.
  const lookupPacks = [
    ...new Set([...(featured ? [featured] : []), ...packs.slice(0, CHASE_LOOKUPS)]),
  ];
  const details = await Promise.all(
    lookupPacks.map((p) => getPackDetail(p.id)),
  );
  const chaseByPack = new Map<string, PackCard | null>(
    lookupPacks.map((p, i) => [p.id, details[i]?.topHits[0] ?? null]),
  );

  const featuredChase = featured
    ? (chaseByPack.get(featured.id) ?? null)
    : null;

  return (
    <div className="px-fluid mx-auto w-full max-w-md pt-4 lg:max-w-5xl">
      {featured && <FeaturedChase pack={featured} chase={featuredChase} />}

      <TrustRow />

      <section aria-labelledby="packs-heading" className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 id="packs-heading" className="font-heading text-2xl text-white">
            RIP A PACK
          </h2>
          <Link
            href="/slots"
            className="flex items-center gap-1 text-[13px] font-semibold text-neutral-400 transition-colors hover:text-white"
          >
            All packs
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {packs.map((pack) => (
            <PackTile
              key={pack.id}
              pack={pack}
              chase={chaseByPack.get(pack.id) ?? null}
            />
          ))}
        </div>
      </section>

      <section className="mt-10">
        <RecentPullsSection initialPulls={pulls} />
      </section>
    </div>
  );
}

/** Full-width hero card: the most expensive in-stock pack and its top chase. */
function FeaturedChase({
  pack,
  chase,
}: {
  pack: Pack;
  chase: PackCard | null;
}) {
  const chaseValue = chase ? priceNumber(chase.value) : 0;
  const tier = priceTier(chaseValue);

  return (
    <Link
      href={`/slots/${pack.id}`}
      className="relative flex overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 transition-colors hover:border-white/25"
    >
      <div className="flex min-w-0 flex-1 flex-col justify-between p-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Top chase
          </p>
          {chase ? (
            <>
              <p className="font-heading text-chase mt-1 text-3xl">
                {chase.value}
              </p>
              <p className="mt-1 truncate text-[13px] text-neutral-400">
                {chase.name}
              </p>
            </>
          ) : (
            <p className="font-heading mt-1 text-3xl text-white">{pack.name}</p>
          )}
        </div>
        <span className="mt-5 inline-flex h-11 w-fit items-center gap-2 whitespace-nowrap rounded-full bg-neutral-50 px-5 text-sm font-semibold text-neutral-950">
          Rip it — {pack.price}
          <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
        </span>
      </div>
      {chase && (
        <div className="relative flex w-36 shrink-0 items-center justify-center p-4 sm:w-44">
          <Image
            src={chase.image}
            alt={chase.name}
            width={140}
            height={196}
            className="h-auto w-full rounded-lg object-contain"
            style={{ boxShadow: `0 0 32px 0 rgba(${TIER_COLOR[tier]}, 0.45)` }}
          />
        </div>
      )}
    </Link>
  );
}

/** The 90scard trust row, Pokenic facts: graded slabs, buyback, vault. */
function TrustRow() {
  const items = [
    { icon: BadgeCheck, label: 'Every pull is a real graded slab' },
    { icon: Banknote, label: 'Instant buyback up to 90%' },
    { icon: Vault, label: 'Vault it, ship it, or sell it' },
  ];
  return (
    <div className="mt-4 grid grid-cols-3 gap-2">
      {items.map(({ icon: Icon, label }) => (
        <div
          key={label}
          className="flex flex-col items-center gap-1.5 rounded-xl border border-white/10 bg-neutral-900 px-2 py-3 text-center"
        >
          <Icon className="h-4 w-4 text-neutral-400" aria-hidden />
          <span className="text-[11px] font-medium leading-tight text-neutral-300">
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One pack in the hub grid; tier color comes from the pack's own price band. */
function PackTile({ pack, chase }: { pack: Pack; chase: PackCard | null }) {
  const tier = priceTier(priceNumber(pack.price));
  const soldOut = pack.inStock === false;

  const tileClass = `relative flex flex-col rounded-2xl border bg-neutral-900 p-3 transition-colors ${
    soldOut ? 'opacity-50' : 'hover:border-white/30'
  }`;
  const tileStyle = { borderColor: `rgba(${TIER_COLOR[tier]}, 0.4)` };

  const body = (
    <>
      <div className="relative flex h-28 items-center justify-center">
        <Image
          src={pack.image}
          alt={pack.name}
          width={112}
          height={112}
          className="h-full w-auto object-contain"
        />
        {soldOut ? (
          <span className="absolute right-0 top-0 rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] font-semibold text-neutral-400">
            Sold out
          </span>
        ) : (
          pack.boost && (
            <span className="absolute right-0 top-0 rounded-full bg-green-400/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">
              {pack.buybackPercent ?? 90}% back
            </span>
          )
        )}
      </div>
      <p className="mt-2 truncate text-[13px] font-semibold text-white">
        {pack.name}
      </p>
      <span className="font-heading mt-0.5 whitespace-nowrap text-lg text-white">
        {pack.price}
      </span>
      {chase && (
        <p className="mt-1 truncate text-[11px] text-neutral-500">
          Top chase <span className="text-neutral-300">{chase.value}</span>
        </p>
      )}
    </>
  );

  // Sold-out tiles are display-only — a real non-target, not an aria hint.
  if (soldOut) {
    return (
      <div className={tileClass} style={tileStyle}>
        {body}
      </div>
    );
  }
  return (
    <Link
      href={`/slots/${encodeURIComponent(pack.id)}`}
      className={tileClass}
      style={tileStyle}
    >
      {body}
    </Link>
  );
}
