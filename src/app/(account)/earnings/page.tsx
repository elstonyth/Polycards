import type { Metadata } from 'next';
import {
  AccountHeader,
  StatCards,
  MockTable,
  Badge,
  DemoNote,
} from '@/components/account/ui';
import { usd } from '@/lib/format';

export const metadata: Metadata = { title: 'Earnings | Pokenic' };

const TYPES = ['Buyback', 'Sale', 'Referral', 'Sale', 'Buyback', 'Sale'];

export default function EarningsPage() {
  const rows = Array.from({ length: 6 }, (_, i) => [
    `2026-0${6 - i}-15`,
    TYPES[i],
    usd(120 + i * 47.5),
    <Badge key="s" tone="green">
      Paid
    </Badge>,
  ]);
  return (
    <>
      <AccountHeader title="Earnings" sub="Sales, buybacks, and payouts." />
      <StatCards
        items={[
          { label: 'Available', value: usd(1284.5) },
          { label: 'Pending', value: usd(312) },
          { label: 'Lifetime', value: usd(18420.75) },
          { label: 'This month', value: usd(947.25), sub: '+12% vs last' },
        ]}
      />
      <div className="mt-5">
        <MockTable head={['Date', 'Type', 'Amount', 'Status']} rows={rows} />
      </div>
      <button
        type="button"
        className="mt-5 rounded-xl bg-neutral-200 px-5 py-2.5 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
      >
        Withdraw to bank
      </button>
      <DemoNote />
    </>
  );
}
