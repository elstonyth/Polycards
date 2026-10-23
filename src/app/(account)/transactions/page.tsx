import type { Metadata } from 'next';
import {
  AccountHeader,
  Badge,
  Pager,
  StatCards,
} from '@/components/account/ui';
import { mytClock, mytDate, rm } from '@/lib/format';
import { getPendingDeposits, getTransactions } from '@/lib/actions/vault';
import {
  bonusMark,
  cardsLine,
  forPacksMark,
  gatewayMethodLabel,
  gatewayStatusLabel,
  reasonLabel,
  signedRm,
} from '@/lib/transactions';
import { MarkCreditsSeen } from '@/components/account/credit-dot';
import { PendingDeposits } from '@/components/account/PendingDeposits';
import { DepositAutoRefresh } from '@/components/account/deposit-autorefresh';

export const metadata: Metadata = { title: 'Transactions' };

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
  // In parallel: the ledger read is the page, and the pending list only
  // decorates it — serialising them would add a round-trip to the very page a
  // customer refreshes while waiting on credit.
  const [res, pending] = await Promise.all([
    getTransactions(Number.isInteger(page) ? page : 1),
    // Only on page 1: a deposit confirming NOW belongs beside the newest rows,
    // not floating above page 7 of history.
    Number.isInteger(page) && page > 1
      ? Promise.resolve([])
      : getPendingDeposits(),
  ]);

  if (!res.ok) {
    return (
      <>
        <AccountHeader title="Transactions" sub="Your top-ups and spending." />
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
          {res.error}
        </p>
        {/* Deliberately shown on the failure branch too: a ledger read that
            broke is the WORST moment to also hide the fact that we can see the
            customer's payment. */}
        <PendingDeposits deposits={pending} />
      </>
    );
  }

  const rows = res.transactions;

  return (
    <>
      {/* Success branch only: clearing the money dot after a FAILED read would
          hide activity the customer never got to see. */}
      <MarkCreditsSeen />
      {/* This page is the gateway's ReturnUrl. A deposit credited by the
          reconcile sweep lands seconds AFTER the customer gets back here, so
          the return trip re-reads itself for a bounded window. */}
      <DepositAutoRefresh />
      <AccountHeader title="Transactions" sub="Your top-ups and spending." />
      <StatCards
        items={[
          { label: 'Balance', value: rm(res.balance) },
          { label: 'Total topped up', value: rm(res.topupTotal) },
          // Split, not one "Total spent": a withdrawal is not spending. An
          // older backend sends no split — keep its single total then.
          ...(res.packSpendTotal == null || res.withdrawnTotal == null
            ? [{ label: 'Total spent', value: rm(res.spendTotal) }]
            : [
                { label: 'Spent on packs', value: rm(res.packSpendTotal) },
                { label: 'Withdrawn', value: rm(res.withdrawnTotal) },
              ]),
        ]}
      />
      {/* Above the table: an in-flight top-up is the thing the customer came
          to look for, and the ledger cannot show it until it settles. */}
      <PendingDeposits deposits={pending} />
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
                {/* Phone: Date and Reference fold into the Type cell — four
                    columns pushed Amount off a 390px screen. */}
                <th className="hidden px-4 py-3 font-medium sm:table-cell">
                  Date
                </th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">
                  Reference
                </th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const bonus = bonusMark(t.bonus);
                const forPacks = forPacksMark(t.playthrough);
                const cards = cardsLine(t.packTitle, t.cardNames);
                // The gateway id support asks for — same value the receipt
                // email and the admin pages show. Internal rows (pack opens,
                // buybacks) have none.
                const reference = (
                  <>
                    <span className="font-mono break-all">
                      {t.reference ?? '—'}
                    </span>
                    {t.gateway ? (
                      <span className="mt-0.5 block text-[11px] text-white/40">
                        {gatewayMethodLabel(t.gateway.method)} ·{' '}
                        {gatewayStatusLabel(t.gateway.status)}
                      </span>
                    ) : null}
                  </>
                );
                return (
                  <tr
                    key={t.id}
                    className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="hidden whitespace-nowrap px-4 py-3 sm:table-cell">
                      <span className="text-white/70">
                        {mytDate(t.createdAt)}
                      </span>
                      <span className="ml-2 hidden text-[12px] text-white/40 sm:inline">
                        {mytClock(t.createdAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white/90">
                      {reasonLabel(t.reason)}
                      {/* Any row that moved spend-only bonus credit — a grant,
                          a bonus-funded open — says how much. */}
                      {bonus && (
                        <span className="ml-2 inline-block whitespace-nowrap align-middle">
                          <Badge>{bonus}</Badge>
                        </span>
                      )}
                      {/* Money into or out of "Still to use on packs" (a
                          top-up, a sell-back's free share, a pack open), so
                          the wallet's figure can be traced row by row. */}
                      {forPacks && (
                        <span className="ml-2 inline-block whitespace-nowrap align-middle">
                          <Badge tone="sky">{forPacks}</Badge>
                        </span>
                      )}
                      {/* Which pack and card(s) a pack open bought or a
                          sell-back sold — the full story is on Pull history. */}
                      {cards && (
                        <span className="mt-0.5 block text-[12px] text-neutral-400">
                          {cards}
                        </span>
                      )}
                      <span className="mt-0.5 block text-[12px] text-white/50 sm:hidden">
                        {mytDate(t.createdAt)}, {mytClock(t.createdAt)}
                      </span>
                      {t.reference && (
                        <span className="mt-0.5 block text-[12px] text-white/50 sm:hidden">
                          {reference}
                        </span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-[12px] text-white/50 sm:table-cell">
                      {reference}
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
