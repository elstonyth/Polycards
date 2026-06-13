import type { Metadata } from 'next';
import { Coins } from 'lucide-react';
import {
  AccountHeader,
  MockTable,
  Badge,
  DemoNote,
} from '@/components/account/ui';
import { num } from '@/lib/format';

export const metadata: Metadata = { title: 'PokéCoin | Pokenic' };

const TX = [
  ['2026-06-02', 'Pack purchase reward', '+250', 'green'],
  ['2026-06-01', 'Marketplace sale', '+1,200', 'green'],
  ['2026-05-30', 'Redeemed for voucher', '-500', 'neutral'],
  ['2026-05-28', 'Daily streak bonus', '+100', 'green'],
  ['2026-05-25', 'Lucky draw entry', '-150', 'neutral'],
] as const;

export default function PokeCoinPage() {
  return (
    <>
      <AccountHeader
        title="PokéCoin"
        sub="Earn coins on every purchase and spend them across Pokenic."
      />
      <div className="mb-5 flex items-center gap-4 rounded-2xl border border-white/10 bg-gradient-to-br from-amber-500/10 to-transparent p-6">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/20 text-amber-300">
          <Coins className="h-7 w-7" aria-hidden />
        </span>
        <div>
          <p className="text-[12px] uppercase tracking-wide text-white/40">
            Balance
          </p>
          <p className="font-heading text-3xl font-bold text-white">
            {num(48250)} <span className="text-lg text-amber-300">PKC</span>
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
            {t[2]} PKC
          </Badge>,
        ])}
      />
      <DemoNote />
    </>
  );
}
