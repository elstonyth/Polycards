import type { Metadata } from 'next';
import { getVault } from '@/lib/actions/vault';
import { getAddresses } from '@/lib/actions/delivery';
import VaultClient from './VaultClient';

export const metadata: Metadata = { title: 'Vault' };

// Server shell: loads the vault + balance + address book with the httpOnly JWT
// (the (account) layout already gates signed-out visitors), then hands off to
// the client grid for the interactive sell-backs + delivery requests.
export default async function VaultPage() {
  const [initial, addresses] = await Promise.all([getVault(), getAddresses()]);
  return <VaultClient initial={initial} addresses={addresses} />;
}
