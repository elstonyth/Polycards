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
import { ArrowUpTray } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useGlobePayWithdrawals } from '../../lib/queries';
import type {
  GlobePayWithdrawal,
  GlobePayWithdrawalView,
} from '../../lib/admin-rest';
import { rm, timeAgo } from '../../lib/format';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'Withdrawals',
  icon: ArrowUpTray,
  nested: '/orders',
  rank: 3,
};

const VIEWS: GlobePayWithdrawalView[] = ['pending', 'settled', 'failed', 'all'];

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
  const { data, isError } = useGlobePayWithdrawals(page, view);

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
            <Text className="text-ui-fg-subtle">{t('withdrawals.empty')}</Text>
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
                  <Table.HeaderCell>{t('withdrawals.when')}</Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('withdrawals.customer')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('withdrawals.destination')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('withdrawals.amount')}
                  </Table.HeaderCell>
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
                    {/* The destination we instructed, verbatim — the dispute
                        record. Their callback never echoes it. */}
                    <Table.Cell className="text-ui-fg-subtle">
                      <div className="whitespace-nowrap">
                        {w.bank_code} · {w.account_number}
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
