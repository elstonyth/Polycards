import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import AccountSidebar from '@/components/account/AccountSidebar';
import { getCustomer } from '@/lib/data/customer';

// Shared shell for the account/wallet pages (URLs stay top-level via the route group).
// Gated: unauthenticated visitors are bounced home with ?auth=login, which the
// header's AuthModal picks up and opens (there is no standalone /login page).
export default async function AccountLayout({
  children,
}: {
  children: ReactNode;
}) {
  const customer = await getCustomer();
  if (!customer) redirect('/?auth=login');

  return (
    <div className="mx-auto w-full px-fluid py-6">
      <div className="flex flex-col gap-6 lg:flex-row">
        <AccountSidebar />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
