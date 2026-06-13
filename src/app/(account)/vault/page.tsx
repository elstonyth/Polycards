import type { Metadata } from 'next';
import { getVault } from '@/lib/actions/vault';
import VaultClient from './VaultClient';

export const metadata: Metadata = { title: 'Vault | Pokenic' };

// Server shell: loads the vault + balance with the httpOnly JWT (the (account)
// layout already gates signed-out visitors), then hands off to the client grid
// for the interactive sell-backs.
export default async function VaultPage() {
  const initial = await getVault();
  return <VaultClient initial={initial} />;
}
