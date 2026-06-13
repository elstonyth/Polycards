import type { Metadata } from 'next';
import { Coins } from 'lucide-react';
import {
  AccountHeader,
  MockTable,
  Badge,
  DemoNote,
} from '@/components/account/ui';
import { num } from '@/lib/format';

export const metadata: Metadata = { title: 'NBACoin | Pokenic' };

const TX = [
  ['2026-06-02', 'Basketball pack reward', '+400', 'green'],
  ['2026-05-31', 'Marketplace sale', '+900', 'green'],
  ['2026-05-29', 'Redeemed for credit', '-1,000', 'neutral'],
  ['2026-05-26', 'Pack Party win', '+650', 'green'],
] as const;

export default function NBACoinPage() {
  return (
    <>
      <AccountHeader
        title="NBACoin"
        sub="Basketball-category rewards you earn and spend on hoops drops."
      />
      <div className="mb-5 flex items-center gap-4 rounded-2xl border border-white/10 bg-gradient-to-br from-sky-500/10 to-transparent p-6">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sky-500/20 text-sky-300">
          <Coins className="h-7 w-7" aria-hidden />
        </span>
        <div>
          <p className="text-[12px] uppercase tracking-wide text-white/40">
            Balance
          </p>
          <p className="font-heading text-3xl font-bold text-white">
            {num(12900)} <span className="text-lg text-sky-300">NBC</span>
          </p>
        </div>
        <button
          type="button"
          className="ml-auto rounded-xl bg-neutral-200 px-5 py-2.5 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
        >
          Redeem
        </button>
      </div>
      <MockTable
        head={['Date', 'Activity', 'Amount']}
        rows={TX.map((t) => [
          t[0],
          t[1],
          <Badge key="a" tone={t[3]}>
            {t[2]} NBC
          </Badge>,
        ])}
      />
      <DemoNote />
    </>
  );
}
