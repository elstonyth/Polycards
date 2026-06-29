import type { Metadata } from 'next';
import Link from 'next/link';
import { Package } from 'lucide-react';
import { AccountHeader, Panel } from '@/components/account/ui';
import { getDeliveryOrders, getAddresses } from '@/lib/actions/delivery';
import { features } from '@/lib/features';
import OrdersClient from './OrdersClient';

export const metadata: Metadata = { title: 'Orders' };

// Per-customer data behind the auth gate — always rendered fresh.
export const dynamic = 'force-dynamic';

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
        Request delivery of a vaulted card and your shipments will show up here.
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
  const [ordersRes, addresses] = await Promise.all([
    getDeliveryOrders(),
    getAddresses(),
  ]);
  // A failed read (expired auth, backend error) must NOT masquerade as "no
  // orders" — surface it so the customer isn't sent down the wrong path.
  if (!ordersRes.ok) {
    return (
      <>
        <AccountHeader
          title="Orders"
          sub="Your delivery requests and shipments."
        />
        <Panel className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <h2 className="font-heading text-lg font-bold text-white">
            Couldn’t load your orders
          </h2>
          <p className="max-w-sm text-sm text-white/50">{ordersRes.error}</p>
        </Panel>
      </>
    );
  }

  const orders = ordersRes.orders;

  if (orders.length === 0) {
    return (
      <>
        <AccountHeader
          title="Orders"
          sub="Your delivery requests and shipments."
        />
        <EmptyState />
      </>
    );
  }

  return (
    <>
      <AccountHeader
        title="Orders"
        sub="Your delivery requests and shipments."
      />
      <OrdersClient orders={orders} addresses={addresses} />
    </>
  );
}
