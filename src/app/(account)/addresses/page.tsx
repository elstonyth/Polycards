import type { Metadata } from 'next';
import { getAddresses } from '@/lib/actions/delivery';
import { AccountHeader } from '@/components/account/ui';
import { AddressesClient } from './AddressesClient';

export const metadata: Metadata = {
  title: 'Addresses',
  description: 'Manage your shipping addresses.',
};

export default async function AddressesPage() {
  const addresses = await getAddresses();
  return (
    <>
      <AccountHeader title="Addresses" sub="Where we ship your cards." />
      <AddressesClient initialAddresses={addresses} />
    </>
  );
}
