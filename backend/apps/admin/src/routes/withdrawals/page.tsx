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
} from '@medusajs/ui';
import { ArrowUpTray } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useGlobePayWithdrawals } from '../../lib/queries';
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

const VIEWS: GlobePayWithdrawalView[] = ['pending', 'settled', 'failed', 'all'];

// EXACTLY the backend's SORTABLE allow-list (api/admin/globepay/withdrawals/
// route.ts) — real columns only, and only the ones this table renders a header
// for. Adding a key here without a header (or vice versa) drifts the two lists.
type SortKey = 'created_at' | 'amount';

// The money-OUT mirror of the Deposits page. Pending is the default view for
// the inverse reason: did we debit somebody whose payout never confirmed AND
// never refunded? A stale pending row (past the sweep window, flagged
// server-side) is that customer until proven otherwise.
const statusBadge = (w: GlobePayWithdrawal, label: string) => {
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
  const [page, setPage] = useState(0);
  const [view, setView] = useState<GlobePayWithdrawalView>('pending');
  // Starts NULL, not seeded — same contract as the Deposits page: the route's
  // status-dependent default order (pending oldest-first) holds until the
  // operator explicitly picks a column.
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
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.withdrawals.map((w) => (
                  <Table.Row key={w.id}>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                      {timeAgo(w.created_at)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      <button
                        type="button"
                        className="text-ui-fg-interactive hover:underline"
                        onClick={() => navigate(`/customers/${w.customer_id}`)}
                      >
                        {w.customer_email ?? w.customer_id.slice(0, 8)}
                      </button>
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
                      {rm(w.amount)}
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
