import type { Metadata } from 'next';
import { AccountHeader, Panel } from '@/components/account/ui';
import SettingsForm from '@/components/account/SettingsForm';
import { getCustomer } from '@/lib/data/customer';

export const metadata: Metadata = { title: 'Settings' };

// Per-customer data behind the auth gate — always rendered fresh.
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const customer = await getCustomer();
  // The account layout gate redirects unauthenticated visitors, so this is a
  // defensive guard for the nullable type rather than a reachable state.
  if (!customer) return null;

  return (
    <>
      <AccountHeader title="Settings" sub="Manage your profile details." />
      <div className="grid gap-3">
        <Panel>
          <h2 className="mb-4 font-heading text-lg font-bold text-white">
            Profile
          </h2>
          <SettingsForm
            customer={{
              id: customer.id,
              email: customer.email,
              first_name: customer.first_name ?? null,
              last_name: customer.last_name ?? null,
              phone: customer.phone ?? null,
            }}
          />
        </Panel>
        {/* One quiet line, not a panel of dead "coming soon" rows: none of
            these have a backend representation yet (launch follow-ups in
            docs/note.md), and a money product must never show a 2FA switch
            that does nothing. */}
        <p className="text-[12px] text-white/55">
          Email notifications, pull alerts, and two-factor authentication are
          still to come.
        </p>
      </div>
    </>
  );
}
