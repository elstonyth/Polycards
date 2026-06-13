import type { Metadata } from 'next';
import Link from 'next/link';
import { Package } from 'lucide-react';
import type { HttpTypes } from '@medusajs/types';
import {
  AccountHeader,
  MockTable,
  Badge,
  Panel,
} from '@/components/account/ui';
import { getOrders } from '@/lib/data/customer';
import { features } from '@/lib/features';

export const metadata: Metadata = { title: 'Orders | Pokenic' };

// Per-customer data behind the auth gate — always rendered fresh.
export const dynamic = 'force-dynamic';

type Tone = 'green' | 'sky' | 'amber' | 'neutral';

// Map Medusa fulfillment status → badge tone + readable label.
const FULFILLMENT: Record<string, Tone> = {
  delivered: 'green',
  partially_delivered: 'green',
  shipped: 'sky',
  partially_shipped: 'sky',
  fulfilled: 'sky',
  partially_fulfilled: 'amber',
  not_fulfilled: 'amber',
  canceled: 'neutral',
};

const humanize = (s: string) =>
  s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const money = (amount: number, currency: string) => {
  try {
    return amount.toLocaleString('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    });
  } catch {
    // Malformed/empty currency_code — degrade gracefully instead of 500-ing.
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`.trim();
  }
};

const orderDate = (value: string | Date) =>
  new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

function OrderItems({ items }: { items: HttpTypes.StoreOrderLineItem[] }) {
  const first = items[0];
  const extra = items.length - 1;
  return (
    <span className="flex items-center gap-2">
      {first?.thumbnail && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={first.thumbnail}
          alt=""
          width={24}
          height={32}
          className="h-8 w-6 shrink-0 rounded object-contain"
        />
      )}
      <span className="max-w-[220px] truncate">{first?.title ?? '—'}</span>
      {extra > 0 && <span className="text-white/45">+{extra} more</span>}
    </span>
  );
}

function EmptyState() {
  return (
    <Panel className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
        <Package className="h-6 w-6 text-white/50" aria-hidden />
      </span>
      <h2 className="font-heading text-lg font-bold text-white">
        No orders yet
      </h2>
      <p className="max-w-sm text-sm text-white/50">
        When you buy or rip a pack, your purchases, shipments, and vaulted cards
        will show up here.
      </p>
      <Link
        href={features.marketplace ? '/marketplace' : '/claw'}
        className="mt-1 inline-flex h-10 items-center rounded-xl bg-neutral-200 px-5 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
      >
        {features.marketplace ? 'Browse the marketplace' : 'Open a pack'}
      </Link>
    </Panel>
  );
}

export default async function OrdersPage() {
  const orders = await getOrders();

  if (orders.length === 0) {
    return (
      <>
        <AccountHeader
          title="Orders"
          sub="Your purchases, shipments, and vaulted items."
        />
        <EmptyState />
      </>
    );
  }

  const rows = orders.map((o) => [
    <span key="o" className="font-mono text-[12px] text-white/60">
      #{o.display_id ?? o.id.slice(-6)}
    </span>,
    <OrderItems key="i" items={o.items ?? []} />,
    orderDate(o.created_at),
    money(o.total, o.currency_code),
    <Badge key="s" tone={FULFILLMENT[o.fulfillment_status] ?? 'neutral'}>
      {humanize(o.fulfillment_status)}
    </Badge>,
  ]);

  return (
    <>
      <AccountHeader
        title="Orders"
        sub="Your purchases, shipments, and vaulted items."
      />
      <MockTable
        head={['Order', 'Item', 'Date', 'Total', 'Status']}
        rows={rows}
      />
    </>
  );
}
