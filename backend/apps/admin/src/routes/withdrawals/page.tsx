import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Container,
  Heading,
  Text,
  Table,
  Select,
  StatusBadge,
  toast,
  usePrompt,
} from '@medusajs/ui';
import { ArrowUpTray } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useGlobePayWithdrawals,
  useApproveGlobePayWithdrawal,
  useDenyGlobePayWithdrawal,
} from '../../lib/queries';
import { getGlobePayWithdrawalAccount } from '../../lib/admin-rest';
import type {
  GlobePayWithdrawal,
  GlobePayWithdrawalView,
} from '../../lib/admin-rest';
import { rm, timeAgo } from '../../lib/format';
import { useTableSort } from '../../lib/use-table-sort';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'Withdrawals',
  icon: ArrowUpTray,
  nested: '/orders',
  rank: 3,
};

// held FIRST and is the page's default view (Task 6, plan 094) — a held row
// is a customer waiting on a HUMAN, which outranks pending's "waiting on the
// gateway". The backend's own default stays 'pending' (route.ts); this SPA
// always sends `status` explicitly, so this ordering/default is what actually
// decides what an operator sees first.
const VIEWS: GlobePayWithdrawalView[] = [
  'held',
  'pending',
  'settled',
  'failed',
  'all',
];

// EXACTLY the backend's SORTABLE allow-list (api/admin/globepay/withdrawals/
// route.ts) — real columns only, and only the ones this table renders a header
// for. Adding a key here without a header (or vice versa) drifts the two lists.
type SortKey = 'created_at' | 'amount';

// The money-OUT mirror of the Deposits page. Pending is the default view for
// the inverse reason: did we debit somebody whose payout never confirmed AND
// never refunded? A stale pending row (past the sweep window, flagged
// server-side) is that customer until proven otherwise.
const statusBadge = (w: GlobePayWithdrawal, label: string) => {
  // held: needs a human, not the gateway — orange reads as "awaiting action"
  // the same way a stale pending row does, without conflating the two (a
  // held row's `stale` is always false; the sweep never touches it).
  if (w.status === 'held')
    return <StatusBadge color="orange">{label}</StatusBadge>;
  if (w.status === 'settled')
    return <StatusBadge color="green">{label}</StatusBadge>;
  // 'failed' on a withdrawal means the debit was REFUNDED — resolved, not an
  // error state, so it renders neutral rather than red.
  if (w.status === 'failed')
    return <StatusBadge color="blue">{label}</StatusBadge>;
  return <StatusBadge color={w.stale ? 'orange' : 'grey'}>{label}</StatusBadge>;
};

const WithdrawalsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const prompt = usePrompt();
  const approveMutation = useApproveGlobePayWithdrawal();
  const denyMutation = useDenyGlobePayWithdrawal();
  const [page, setPage] = useState(0);
  const [view, setView] = useState<GlobePayWithdrawalView>('held');
  // Starts NULL, not seeded — same contract as the Deposits page: the route's
  // status-dependent default order (pending AND held oldest-first — Task 6,
  // plan 094) holds until the operator explicitly picks a column.
  const { sort, sortHeader } = useTableSort<SortKey>(null, {
    onChange: () => setPage(0),
  });
  const { data, isError } = useGlobePayWithdrawals(
    page,
    view,
    sort ? `${sort.key}:${sort.dir}` : undefined,
  );

  // Revealed account numbers, keyed by row id. Kept in component state rather
  // than the query cache on purpose: each reveal is a logged, rate-limited
  // server call, so it must not be re-fetched on a refocus, and it must not
  // outlive this page — navigating away drops them.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  // A SET, not one id: two reveals can be in flight at once. With a single
  // slot, clicking row A then row B overwrites the id, and A settling clears it
  // while B is still loading — B's button re-enables and can be clicked again.
  // Each click is a logged, rate-limited server call, so the disabled state has
  // to be accurate per row.
  const [revealing, setRevealing] = useState<ReadonlySet<string>>(new Set());

  const reveal = async (id: string) => {
    if (revealing.has(id)) return;
    setRevealing((prev) => new Set(prev).add(id));
    try {
      const { account_number } = await getGlobePayWithdrawalAccount(id);
      setRevealed((prev) => ({ ...prev, [id]: account_number }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRevealing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Row ids currently running an approve or deny. Added BEFORE the confirm
  // prompt even opens (not after it resolves) — a click that only starts
  // disabling once the operator confirms leaves a real window where a
  // double-click opens two prompts, and through them two approves. Shared by
  // both actions per row: once either is in flight, both of that row's
  // buttons disable, since they are mutually exclusive outcomes for the same
  // withdrawal.
  const [acting, setActing] = useState<ReadonlySet<string>>(new Set());

  const withActing = async (id: string, run: () => Promise<void>) => {
    if (acting.has(id)) return;
    setActing((prev) => new Set(prev).add(id));
    try {
      await run();
    } catch {
      // Swallowed: the mutation's own onError already toasted the specific
      // backend refusal (frozen account, wrong status, channel closed, …).
      // Nothing left to surface here — just fall through to re-enable below.
    } finally {
      setActing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Confirm copy always uses the MASKED destination (w.account_number),
  // never `revealed[w.id]` even if the operator already revealed this row —
  // the brief asks for "the masked destination", and the confirm step is the
  // last gate before a real bank payout, not a second reveal surface.
  const approveHeld = (w: GlobePayWithdrawal) =>
    withActing(w.id, async () => {
      const ok = await prompt({
        title: t('withdrawals.confirmApproveTitle'),
        description: t('withdrawals.confirmApproveBody', {
          amount: rm(w.amount),
          bank: w.bank_code,
          account: w.account_number,
          holder: w.account_holder_name,
        }),
        confirmText: t('withdrawals.approve'),
        variant: 'confirmation',
      });
      if (!ok) return;
      await approveMutation.mutateAsync(w.id);
    });

  const denyHeld = (w: GlobePayWithdrawal) =>
    withActing(w.id, async () => {
      const ok = await prompt({
        title: t('withdrawals.confirmDenyTitle'),
        description: t('withdrawals.confirmDenyBody', {
          amount: rm(w.amount),
          bank: w.bank_code,
          account: w.account_number,
          holder: w.account_holder_name,
        }),
        confirmText: t('withdrawals.deny'),
        variant: 'danger',
      });
      if (!ok) return;
      await denyMutation.mutateAsync(w.id);
    });

  // A view change restarts paging — page 3 of "pending" has nothing to do
  // with page 3 of "all".
  const changeView = (next: string) => {
    setView(next as GlobePayWithdrawalView);
    setPage(0);
  };

  const staleOnPage = data?.withdrawals.filter((w) => w.stale).length ?? 0;

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
          <div>
            <Heading level="h2">{t('withdrawals.title')}</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t('withdrawals.subtitle')}
            </Text>
          </div>
          <Select value={view} onValueChange={changeView}>
            <Select.Trigger className="w-44">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {VIEWS.map((v) => (
                <Select.Item key={v} value={v}>
                  {t(`withdrawals.view.${v}`)}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>

        {staleOnPage > 0 && (
          <div className="border-t px-6 py-3">
            <Text size="small" className="text-ui-fg-error">
              {/* `n`, not `count` — i18next treats `count` as a plural selector. */}
              {t('withdrawals.staleWarning', { n: staleOnPage })}
            </Text>
          </div>
        )}

        {isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {t('withdrawals.loadError')}
            </Text>
          </div>
        ) : !data ? (
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : data.withdrawals.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {data.total > 0
                ? t('withdrawals.emptyPage', { total: data.total })
                : view === 'all'
                  ? t('withdrawals.emptyAll')
                  : t('withdrawals.emptyView', {
                      view: t(`withdrawals.view.${view}`),
                    })}
            </Text>
            {data.total > 0 ? (
              <Button
                size="small"
                variant="secondary"
                className="mt-3"
                onClick={() => setPage(0)}
              >
                {t('withdrawals.firstPage')}
              </Button>
            ) : (
              view !== 'all' && (
                <Button
                  size="small"
                  variant="secondary"
                  className="mt-3"
                  onClick={() => changeView('all')}
                >
                  {t('withdrawals.showAll')}
                </Button>
              )
            )}
          </div>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label={t('withdrawals.tableLabel')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  {sortHeader('created_at', t('withdrawals.when'))}
                  <Table.HeaderCell>
                    {t('withdrawals.customer')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('withdrawals.destination')}
                  </Table.HeaderCell>
                  {sortHeader('amount', t('withdrawals.amount'), true)}
                  <Table.HeaderCell>{t('withdrawals.status')}</Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('withdrawals.reference')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('withdrawals.actions')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.withdrawals.map((w) => (
                  <Table.Row key={w.id}>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                      {timeAgo(w.created_at)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      <div className="flex items-center gap-x-2 whitespace-nowrap">
                        <button
                          type="button"
                          className="text-ui-fg-interactive hover:underline"
                          onClick={() =>
                            navigate(`/customers/${w.customer_id}`)
                          }
                        >
                          {w.customer_email ?? w.customer_id.slice(0, 8)}
                        </button>
                        {/* Approve refuses on a frozen account (Task 5) — this
                            is a PREVIEW as of the last page load, re-checked
                            live at click time, so it can lag a freeze that
                            landed seconds ago. Shown so the approver sees the
                            reason before clicking into that refusal. */}
                        {w.frozen && (
                          <StatusBadge color="red">
                            {t('withdrawals.frozen')}
                          </StatusBadge>
                        )}
                      </div>
                    </Table.Cell>
                    {/* The destination we instructed — the dispute record,
                        since their callback never echoes it. Masked by the
                        route; the full number is fetched per row on demand,
                        and every reveal is logged server-side. */}
                    <Table.Cell className="text-ui-fg-subtle">
                      <div className="flex items-center gap-x-2 whitespace-nowrap">
                        <span>
                          {w.bank_code} · {revealed[w.id] ?? w.account_number}
                        </span>
                        {!revealed[w.id] && (
                          <button
                            type="button"
                            className="text-ui-fg-interactive text-xs hover:underline disabled:opacity-50"
                            disabled={revealing.has(w.id)}
                            onClick={() => reveal(w.id)}
                          >
                            {t('withdrawals.reveal')}
                          </button>
                        )}
                      </div>
                      <div className="text-ui-fg-muted text-xs">
                        {w.account_holder_name}
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      <div>{rm(w.amount)}</div>
                      {/* Settlement mirror: settled ≠ instructed is the
                          durable form of the disagreement the callback logs;
                          net is what actually left after their fee. NULL =
                          pre-mirror row (unknown), rendered as nothing rather
                          than RM 0.00. */}
                      {w.amount_settled !== null &&
                        w.amount_settled !== w.amount && (
                          <div className="text-ui-fg-error text-xs">
                            {t('withdrawals.settledAs', {
                              amount: rm(w.amount_settled),
                            })}
                          </div>
                        )}
                      {w.net_amount !== null && (
                        <div className="text-ui-fg-muted text-xs">
                          {t('withdrawals.netLabel', {
                            amount: rm(w.net_amount),
                          })}
                        </div>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {statusBadge(
                        w,
                        w.stale
                          ? t('withdrawals.statusStale')
                          : t(`withdrawals.statusLabel.${w.status}`),
                      )}
                    </Table.Cell>
                    {/* Ours (merchant) is what their back office lists; theirs
                        (W…) exists once SubmitWithdrawal returned. */}
                    <Table.Cell className="text-ui-fg-subtle font-mono text-xs break-all">
                      <div>{w.merchant_transaction_id}</div>
                      {w.gateway_transaction_id && (
                        <div className="text-ui-fg-muted">
                          {w.gateway_transaction_id}
                        </div>
                      )}
                      {/* The BANK's own refs (settlement mirror) — what the
                          receiving bank quotes in a dispute. Null on rows
                          settled before the mirror. */}
                      {w.bank_reference_no && (
                        <div className="text-ui-fg-muted">
                          {t('withdrawals.bankRef')}: {w.bank_reference_no}
                        </div>
                      )}
                      {w.unique_reference_no && (
                        <div className="text-ui-fg-muted">
                          {t('withdrawals.uniqueRef')}: {w.unique_reference_no}
                        </div>
                      )}
                      {/* Plan 095 forensics, in the references cell rather
                          than a seventh column: it is the only wide cell, and
                          both strings are diagnostic detail an operator reads
                          when a row already caught their eye. */}
                      {w.failure_reason && (
                        <div className="text-ui-fg-muted mt-1">
                          {w.failure_reason}
                        </div>
                      )}
                      {/* Their Payout Verification is active, so a failed row
                          with no outcome recorded is worth a look — but it is a
                          POINTER, not a verdict: their call may never have
                          arrived, it may have been refused before we could
                          match it to this row, or the row may predate the
                          column. The copy says exactly that. */}
                      {w.status === 'failed' && !w.verify_outcome && (
                        <div className="text-ui-tag-orange-text mt-1 font-sans">
                          {t('withdrawals.noVerify')}
                        </div>
                      )}
                      {w.verify_outcome && (
                        <div className="text-ui-fg-muted mt-1">
                          {w.verify_outcome}
                        </div>
                      )}
                    </Table.Cell>
                    {/* held rows only — the row's own status, never the
                        current VIEW: the 'all' view mixes every status, and a
                        row that just left 'held' must not keep its buttons
                        until the next poll. */}
                    <Table.Cell>
                      {w.status === 'held' ? (
                        <div className="flex items-center gap-x-2">
                          {/* Pre-emptively disabled on a frozen account: the
                              backend refuses this one anyway (Task 5), so
                              skip the doomed round-trip — the red badge above
                              is the explanation, not a hover title (disabled
                              buttons don't reliably fire hover). */}
                          <Button
                            size="small"
                            variant="primary"
                            disabled={acting.has(w.id) || w.frozen}
                            onClick={() => approveHeld(w)}
                          >
                            {t('withdrawals.approve')}
                          </Button>
                          {/* NOT disabled on frozen — deny only ever returns
                              money to the customer's own balance, and the
                              backend never gates it on freeze either. */}
                          <Button
                            size="small"
                            variant="danger"
                            disabled={acting.has(w.id)}
                            onClick={() => denyHeld(w)}
                          >
                            {t('withdrawals.deny')}
                          </Button>
                        </div>
                      ) : (
                        <Text size="small" className="text-ui-fg-muted">
                          —
                        </Text>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
        {data && (
          <Pager
            page={page}
            onPage={setPage}
            pageSize={data.limit}
            count={data.withdrawals.length}
            total={data.total}
          />
        )}
      </Container>
    </div>
  );
};

export default WithdrawalsPage;
