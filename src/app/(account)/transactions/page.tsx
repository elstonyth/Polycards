import type { Metadata } from 'next';
import { AccountHeader, StatCards } from '@/components/account/ui';
import { rm } from '@/lib/format';
import { getTransactions } from '@/lib/actions/vault';
import { reasonLabel, signedRm } from '@/lib/transactions';

export const metadata: Metadata = { title: 'Transactions' };

// The credit ledger: lifetime money in/out + the recent transactions. The
// (account) layout already gates signed-out visitors; getTransactions reads the
// httpOnly JWT. No interactivity → server component, no client island.
export default async function TransactionsPage() {
  const res = await getTransactions();

  if (!res.ok) {
    return (
      <>
        <AccountHeader title="Transactions" sub="Your top-ups and spending." />
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
          {res.error}
        </p>
      </>
    );
  }

  const rows = res.transactions;

  return (
    <>
      <AccountHeader
        title="Transactions"
        sub="Every top-up and spend on your account."
      />
      <StatCards
        items={[
          { label: 'Current balance', value: rm(res.balance) },
          { label: 'Total topped up', value: rm(res.topupTotal) },
          { label: 'Total spent', value: rm(res.spendTotal) },
        ]}
      />
      <div className="mt-5 overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03]">
        {rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-white/50">
            No transactions yet.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-[12px] uppercase tracking-wide text-white/50">
              <tr className="border-b border-white/10">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-4 py-3 text-white/70">
                    {new Date(t.createdAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </td>
                  <td className="px-4 py-3 text-white/90">
                    {reasonLabel(t.reason)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-medium ${
                      t.amount > 0 ? 'text-emerald-300' : 'text-white/80'
                    }`}
                  >
                    {signedRm(t.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
