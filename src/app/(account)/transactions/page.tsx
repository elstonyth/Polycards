import type { Metadata } from 'next';
import { AccountHeader, Pager, StatCards } from '@/components/account/ui';
import { rm } from '@/lib/format';
import { getTransactions } from '@/lib/actions/vault';
import { reasonLabel, signedRm } from '@/lib/transactions';

export const metadata: Metadata = { title: 'Transactions' };

const dateFmt = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

// The credit ledger: lifetime money in/out + a server-paged transaction list
// (?page=N). The (account) layout already gates signed-out visitors;
// getTransactions reads the httpOnly JWT. No interactivity → server component.
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageRaw } = await searchParams;
  const page = Number(pageRaw);
  const res = await getTransactions(Number.isInteger(page) ? page : 1);

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
      <AccountHeader title="Transactions" sub="Your top-ups and spending." />
      <StatCards
        items={[
          { label: 'Current balance', value: rm(res.balance) },
          { label: 'Total topped up', value: rm(res.topupTotal) },
          { label: 'Total spent', value: rm(res.spendTotal) },
        ]}
      />
      <div className="mt-5 overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03]">
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center">
            {res.page > 1 ? (
              <>
                <p className="text-sm font-semibold text-white">
                  Nothing on this page.
                </p>
                <p className="mt-1 text-[13px] text-white/50">
                  You&rsquo;ve reached the end of your transaction history.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-white">
                  No transactions yet.
                </p>
                <p className="mt-1 text-[13px] text-white/50">
                  Top-ups, pack opens, and sell-backs all land here.
                </p>
              </>
            )}
          </div>
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
              {rows.map((t) => {
                const at = new Date(t.createdAt);
                return (
                  <tr
                    key={t.id}
                    className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="text-white/70">
                        {dateFmt.format(at)}
                      </span>
                      <span className="ml-2 hidden text-[12px] text-white/40 sm:inline">
                        {timeFmt.format(at)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white/90">
                      {reasonLabel(t.reason)}
                    </td>
                    <td
                      className={`whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums ${
                        t.amount > 0 ? 'text-buyback-fg' : 'text-white/80'
                      }`}
                    >
                      {signedRm(t.amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <Pager page={res.page} hasMore={res.hasMore} basePath="/transactions" />
    </>
  );
}
