import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import Reveal from '@/components/Reveal';
import { SlabImage } from '@/components/SlabImage';
import { rm } from '@/lib/format';
import { MOCK_CARDS } from '@/lib/mock/cards';
import { MOCK_USERS, findUser } from '@/lib/mock/users';
import { DEMO_STATS } from '@/lib/demo-stats';

export const metadata: Metadata = {
  title: 'Marketplace Activity',
  description:
    'Track all marketplace activities and transactions in real-time.',
};

const STATS = [
  { value: DEMO_STATS.transactions, label: 'transactions' },
  { value: DEMO_STATS.volume, label: 'volume' },
  { value: DEMO_STATS.listings, label: 'listings' },
];

type TxType = 'BUY' | 'CLAW' | 'SALE' | 'LIST';
// Neutral tones everywhere except SALE — the seller receives funds, and
// buyback green is reserved for money-in.
const TYPE_TONE: Record<TxType, string> = {
  BUY: 'bg-white/10 text-white/70',
  CLAW: 'bg-white/10 text-white/70',
  SALE: 'bg-buyback/15 text-buyback-fg',
  LIST: 'bg-white/10 text-white/70',
};
const CLAW = 'Slots';
const MARKET = 'Marketplace';

// Mock transaction feed (real-time stream is a backend/Socket.io feed).
const FEED = MOCK_CARDS.slice(0, 16).map((card, i) => {
  const type = (['BUY', 'CLAW', 'SALE', 'LIST'] as TxType[])[i % 4]!;
  const a = MOCK_USERS[i % MOCK_USERS.length]!.username;
  const b = MOCK_USERS[(i + 3) % MOCK_USERS.length]!.username;
  const from = type === 'CLAW' ? CLAW : a;
  const to =
    type === 'BUY' ? CLAW : type === 'LIST' ? MARKET : type === 'CLAW' ? a : b;
  return {
    card,
    type,
    from,
    to,
    price: card.price,
    time: `${(i + 1) * 2}m ago`,
  };
});

function Actor({ name }: { name: string }) {
  if (name === CLAW || name === MARKET) {
    return <span className="text-white/50">{name}</span>;
  }
  const u = findUser(name);
  return (
    <Link
      href={`/profile/${name}`}
      className="inline-flex min-h-6 items-center gap-1.5 text-white/80 hover:text-white hover:underline"
    >
      {u && (
        <Image
          src={u.pfp}
          alt=""
          width={20}
          height={20}
          className="h-5 w-5 rounded-full object-cover"
        />
      )}
      <span className="max-w-[120px] truncate">{name}</span>
    </Link>
  );
}

export default function ActivityPage() {
  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* Hero */}
      <Reveal as="header" className="py-10 text-center sm:py-14">
        <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center [perspective:600px]">
          <Image
            src="/3dicons/activity-coin.webp"
            alt=""
            aria-hidden
            width={80}
            height={80}
            className="h-20 w-20 object-contain drop-shadow-[0_8px_24px_rgba(0,0,0,0.5)] [animation:coinSpin_3.5s_linear_infinite] motion-reduce:[animation:none]"
          />
        </div>
        <h1 className="font-heading text-4xl font-bold tracking-tight text-white sm:text-5xl">
          Marketplace Activity
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm text-white/55 sm:text-base">
          Track all marketplace activities and transactions in real-time
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[13px] text-white/60 sm:text-sm">
          {STATS.map((s, i) => (
            <span key={s.label} className="flex items-center gap-3">
              {i > 0 && (
                <span aria-hidden className="text-white/20">
                  ·
                </span>
              )}
              <span>
                <span className="font-bold text-white">{s.value}</span>{' '}
                {s.label}
              </span>
            </span>
          ))}
        </div>
      </Reveal>

      {/* Transaction table */}
      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03]">
        <table className="w-full min-w-[680px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[12px] uppercase tracking-wide text-white/60">
              <th className="px-4 py-3 font-medium">Item</th>
              <th className="px-4 py-3 font-medium">Price</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">From</th>
              <th className="px-4 py-3 font-medium">To</th>
              <th className="px-4 py-3 text-right font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {FEED.map((row, i) => (
              <tr
                key={i}
                className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
              >
                <td className="px-4 py-2.5">
                  <Link
                    href={`/card/${row.card.id}`}
                    className="flex items-center gap-2.5 hover:underline"
                  >
                    <SlabImage
                      src={row.card.image}
                      slabSrc={row.card.slabImage}
                      alt=""
                      sizes="28px"
                      className="w-7 shrink-0"
                    />
                    <span className="max-w-[260px] truncate text-white/85">
                      {row.card.name}
                    </span>
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-white">
                  {rm(row.price)}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${TYPE_TONE[row.type]}`}
                  >
                    {row.type === 'CLAW' ? 'SLOTS' : row.type}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <Actor name={row.from} />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <Actor name={row.to} />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right text-[12px] text-white/60">
                  {row.time}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-center text-[11px] text-white/55">
        Demo feed — the live activity stream goes live with the backend.
      </p>
    </div>
  );
}
