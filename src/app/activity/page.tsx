import type { Metadata } from 'next';
import Link from 'next/link';
import Reveal from '@/components/Reveal';
import { usd } from '@/lib/format';
import { MOCK_CARDS } from '@/lib/mock/cards';
import { MOCK_USERS, findUser } from '@/lib/mock/users';

export const metadata: Metadata = {
  title: 'Marketplace Activity — Pokenic',
  description:
    'Track all marketplace activities and transactions in real-time.',
};

const STATS = [
  { value: '2.6M', label: 'transactions' },
  { value: '$322.7MM', label: 'volume' },
  { value: '19.8K', label: 'listings' },
];

type TxType = 'BUY' | 'CLAW' | 'SALE' | 'LIST';
const TYPE_TONE: Record<TxType, string> = {
  BUY: 'bg-emerald-500/15 text-emerald-400',
  CLAW: 'bg-sky-500/15 text-sky-400',
  SALE: 'bg-amber-500/15 text-amber-400',
  LIST: 'bg-fuchsia-500/15 text-fuchsia-400',
};
const CLAW = 'Claw Machine';
const MARKET = 'Marketplace';

// Mock transaction feed (real-time stream is a backend/Socket.io feed).
const FEED = MOCK_CARDS.slice(0, 16).map((card, i) => {
  const type = (['BUY', 'CLAW', 'SALE', 'LIST'] as TxType[])[i % 4];
  const a = MOCK_USERS[i % MOCK_USERS.length].username;
  const b = MOCK_USERS[(i + 3) % MOCK_USERS.length].username;
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
    return <span className="text-white/45">{name}</span>;
  }
  const u = findUser(name);
  return (
    <Link
      href={`/profile/${name}`}
      className="inline-flex items-center gap-1.5 text-white/80 hover:text-white hover:underline"
    >
      {u && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={u.pfp} alt="" className="h-5 w-5 rounded-full object-cover" />
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/3dicons/activity-coin.webp"
            alt=""
            aria-hidden
            className="h-20 w-20 object-contain drop-shadow-[0_8px_24px_rgba(0,0,0,0.5)] [animation:coinSpin_3.5s_linear_infinite] motion-reduce:[animation:none]"
          />
        </div>
        <h1 className="font-heading bg-gradient-to-b from-white via-white to-white/40 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
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
            <tr className="border-b border-white/10 text-left text-[12px] uppercase tracking-wide text-white/40">
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
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={row.card.image}
                      alt=""
                      className="h-10 w-7 shrink-0 rounded object-contain"
                    />
                    <span className="max-w-[260px] truncate text-white/85">
                      {row.card.name}
                    </span>
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-white">
                  {usd(row.price)}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${TYPE_TONE[row.type]}`}
                  >
                    {row.type}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <Actor name={row.from} />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <Actor name={row.to} />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right text-[12px] text-white/40">
                  {row.time}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-center text-[11px] text-white/35">
        Demo feed — the live activity stream goes live with the backend.
      </p>
    </div>
  );
}
