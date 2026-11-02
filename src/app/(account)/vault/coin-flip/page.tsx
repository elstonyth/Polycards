import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCustomer } from '@/lib/data/customer';
import { getVault } from '@/lib/actions/vault';
import { getCoinFlipSettings } from '@/lib/actions/coin-flip';
import { getTicketBalance } from '@/lib/actions/lucky-draw';
import { CoinFlipClient } from './CoinFlipClient';

export const metadata: Metadata = { title: 'Vault coin flip' };
export default async function CoinFlipPage({
  searchParams,
}: {
  searchParams: Promise<{
    pull?: string | string[];
    stake?: string;
  }>;
}) {
  const [customer, vault, settings, tickets, params] = await Promise.all([
    getCustomer(),
    getVault(),
    getCoinFlipSettings(),
    getTicketBalance(),
    searchParams,
  ]);
  if (!customer) redirect('/?auth=login');
  return (
    <CoinFlipClient
      key={customer.id}
      customerId={customer.id}
      initialVault={vault}
      initialSettings={settings}
      initialPullId={params.pull}
      initialTickets={tickets}
      initialStake={params.stake === 'tickets' ? 'tickets' : 'cards'}
    />
  );
}
