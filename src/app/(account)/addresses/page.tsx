import type { Metadata } from 'next';
import { getAddresses } from '@/lib/actions/delivery';
import { AddressesClient } from './AddressesClient';

export const metadata: Metadata = {
  title: 'Addresses',
  description: 'Manage your shipping addresses.',
};

export default async function AddressesPage() {
  const addresses = await getAddresses();
  return <AddressesClient initialAddresses={addresses} />;
}
