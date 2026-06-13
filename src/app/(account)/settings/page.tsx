import type { Metadata } from 'next';
import { AccountHeader, Panel } from '@/components/account/ui';
import SettingsForm from '@/components/account/SettingsForm';
import { getCustomer } from '@/lib/data/customer';

export const metadata: Metadata = { title: 'Settings | Pokenic' };

// Per-customer data behind the auth gate — always rendered fresh.
export const dynamic = 'force-dynamic';

// Static visual preferences — these don't persist yet (no backend representation;
// 2FA/notifications are tracked as launch follow-ups in docs/note.md).
const TOGGLES = [
  'Email notifications',
  'Pull alerts',
  'Marketplace activity',
  'Two-factor authentication',
];

export default async function SettingsPage() {
  const customer = await getCustomer();
  // The account layout gate redirects unauthenticated visitors, so this is a
  // defensive guard for the nullable type rather than a reachable state.
  if (!customer) return null;

  return (
    <>
      <AccountHeader
        title="Settings"
        sub="Manage your profile, security, and notifications."
      />
      <div className="grid gap-5 lg:grid-cols-2">
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
        <Panel>
          <h2 className="mb-4 font-heading text-lg font-bold text-white">
            Notifications &amp; security
          </h2>
          <ul className="flex flex-col divide-y divide-white/5">
            {TOGGLES.map((t, i) => (
              <li key={t} className="flex items-center justify-between py-3">
                <span className="text-sm text-white/80">{t}</span>
                <span
                  className={`flex h-6 w-11 items-center rounded-full p-0.5 ${i % 2 === 0 ? 'justify-end bg-emerald-500/80' : 'justify-start bg-white/15'}`}
                >
                  <span className="h-5 w-5 rounded-full bg-white" />
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-white/35">
            Preferences are illustrative and don&apos;t persist yet.
          </p>
        </Panel>
      </div>
    </>
  );
}
