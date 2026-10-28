import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCustomer } from '@/lib/data/customer';
import { getVault } from '@/lib/actions/vault';
import { getCoinFlipSettings } from '@/lib/actions/coin-flip';
import { CoinFlipClient } from './CoinFlipClient';

export const metadata: Metadata = { title: 'Vault coin flip' };
export default async function CoinFlipPage({ searchParams }: { searchParams: Promise<{ pull?: string; round?: string }> }) {
  const [customer, vault, settings, params] = await Promise.all([getCustomer(), getVault(), getCoinFlipSettings(), searchParams]);
  if (!customer) redirect('/?auth=login');
  return <CoinFlipClient customerId={customer.id} initialVault={vault} initialSettings={settings}
    initialPullId={params.pull} initialRoundId={params.round} />;
}
