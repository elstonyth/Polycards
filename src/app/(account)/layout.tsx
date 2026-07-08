import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getCustomer } from '@/lib/data/customer';
import ReferralCookieClaim from './ReferralCookieClaim';

// Shared shell for the account/wallet pages (URLs stay top-level via the route group).
// Gated: unauthenticated visitors are bounced home with ?auth=login, which the
// header's AuthModal picks up and opens (there is no standalone /login page).
// Nav lives in the Me tab + bottom TabBar now — no sidebar chrome.
export default async function AccountLayout({
  children,
}: {
  children: ReactNode;
}) {
  const customer = await getCustomer();
  if (!customer) redirect('/?auth=login');

  return (
    <div className="mx-auto w-full max-w-2xl px-fluid py-6 lg:max-w-4xl">
      <ReferralCookieClaim />
      {children}
    </div>
  );
}
