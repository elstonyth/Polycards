import type { Metadata } from 'next';
import { getVault } from '@/lib/actions/vault';
import { getAddresses } from '@/lib/actions/delivery';
import { getPackGifts } from '@/lib/actions/pack-gifts';
import { AccountHeader } from '@/components/account/ui';
import VaultClient from './VaultClient';

export const metadata: Metadata = { title: 'Vault' };

// Server shell: loads the vault + balance + address book + gifted packs with
// the httpOnly JWT (the (account) layout already gates signed-out visitors),
// then hands off to the client grid for the interactive sell-backs + delivery
// requests.
export default async function VaultPage() {
  const [initial, addresses, gifts] = await Promise.all([
    getVault(),
    getAddresses(),
    getPackGifts(),
  ]);
  return (
    <>
      <AccountHeader
        title="Vault"
        sub="Every card you’ve pulled. Hold, ship, or sell back instantly."
      />
      <VaultClient
        initial={initial}
        addresses={addresses}
        // Unreadable reads as none: the Packs row simply stays hidden.
        initialGifts={gifts ?? []}
      />
    </>
  );
}
