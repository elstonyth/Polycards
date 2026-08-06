import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Container,
  Heading,
  Text,
  Table,
  Select,
  StatusBadge,
} from '@medusajs/ui';
import { CurrencyDollar } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useGlobePayDeposits } from '../../lib/queries';
import type {
  GlobePayDeposit,
  GlobePayDepositView,
} from '../../lib/admin-rest';
import { rm, timeAgo } from '../../lib/format';
import { useTableSort } from '../../lib/use-table-sort';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'Deposits',
  icon: CurrencyDollar,
  nested: '/orders',
  rank: 2,
};

const VIEWS: GlobePayDepositView[] = ['pending', 'settled', 'failed', 'all'];

// EXACTLY the backend's SORTABLE allow-list (api/admin/globepay/deposits/
// route.ts) — real columns only. Customer and status are computed/joined
// server-side after the page is fetched, so those headers stay plain.
type SortKey = 'created_at' | 'amount_requested' | 'settled_at';

// Pending is the default view because this page exists for ONE question: did
// somebody pay and not get credit? A stale pending row (older than the sweep's
// stale window, flagged server-side) is that case until proven otherwise.
const statusBadge = (d: GlobePayDeposit, label: string) => {
  if (d.status === 'settled')
    return <StatusBadge color="green">{label}</StatusBadge>;
  if (d.status === 'failed')
    return <StatusBadge color="red">{label}</StatusBadge>;
  return <StatusBadge color={d.stale ? 'orange' : 'grey'}>{label}</StatusBadge>;
};

const DepositsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [view, setView] = useState<GlobePayDepositView>('pending');
  // Starts NULL, not seeded: with no explicit sort the route orders pending
  // oldest-first (the work queue) and history views newest-first, and a seeded
  // default would silently flatten that. First header click opts in.
  const { sort, sortHeader } = useTableSort<SortKey>(null, {
    onChange: () => setPage(0),
  });
  const { data, isError } = useGlobePayDeposits(
    page,
    view,
    sort ? `${sort.key}:${sort.dir}` : undefined,
  );

  // A view change restarts paging: page 3 of "pending" has nothing to do with
  // page 3 of "all", and keeping the offset lands the operator on an empty page.
  const changeView = (next: string) => {
    setView(next as GlobePayDepositView);
    setPage(0);
  };

  const staleOnPage = data?.deposits.filter((d) => d.stale).length ?? 0;

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
          <div>
            <Heading level="h2">{t('deposits.title')}</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t('deposits.subtitle')}
            </Text>
          </div>
          <Select value={view} onValueChange={changeView}>
            <Select.Trigger className="w-44">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {VIEWS.map((v) => (
                <Select.Item key={v} value={v}>
                  {t(`deposits.view.${v}`)}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>

        {staleOnPage > 0 && (
          <div className="border-t px-6 py-3">
            <Text size="small" className="text-ui-fg-error">
              {/* `n`, not `count`: i18next treats `count` as a plural selector
                  and resolves suffixed keys before the base one. */}
              {t('deposits.staleWarning', { n: staleOnPage })}
            </Text>
          </div>
        )}

        {isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">{t('deposits.loadError')}</Text>
          </div>
        ) : !data ? (
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : data.deposits.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">{t('deposits.empty')}</Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label={t('deposits.tableLabel')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  {sortHeader('created_at', t('deposits.when'))}
                  <Table.HeaderCell>{t('deposits.customer')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('deposits.method')}</Table.HeaderCell>
                  {sortHeader(
                    'amount_requested',
                    t('deposits.requested'),
                    true,
                  )}
                  {sortHeader('settled_at', t('deposits.settled'), true)}
                  <Table.HeaderCell>{t('deposits.status')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('deposits.reference')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.deposits.map((d) => (
                  <Table.Row key={d.id}>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                      {timeAgo(d.created_at)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      <button
                        type="button"
                        className="text-ui-fg-interactive hover:underline"
                        onClick={() => navigate(`/customers/${d.customer_id}`)}
                      >
                        {d.customer_email ?? d.customer_id.slice(0, 8)}
                      </button>
                    </Table.Cell>
                    <Table.Cell>{d.payment_method_code}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      {rm(d.amount_requested)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums whitespace-nowrap">
                      {d.amount_settled === null ? '—' : rm(d.amount_settled)}
                    </Table.Cell>
                    <Table.Cell>
                      {statusBadge(
                        d,
                        d.stale
                          ? t('deposits.statusStale')
                          : t(`deposits.statusLabel.${d.status}`),
                      )}
                    </Table.Cell>
                    {/* Both references are what support quotes to the provider:
                        ours (merchant) is what their back office lists, theirs
                        (gateway) is null until SubmitDeposit returned. */}
                    <Table.Cell className="text-ui-fg-subtle font-mono text-xs break-all">
                      <div>{d.merchant_transaction_id}</div>
                      {d.gateway_transaction_id && (
                        <div className="text-ui-fg-muted">
                          {d.gateway_transaction_id}
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
            count={data.deposits.length}
            total={data.total}
          />
        )}
      </Container>
    </div>
  );
};

export default DepositsPage;
