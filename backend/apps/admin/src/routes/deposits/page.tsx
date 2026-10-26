import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Container, Heading, Text, Table, Select } from '@medusajs/ui';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useGatewayDeposits } from '../../lib/queries';
import type { GatewayDepositView } from '../../lib/admin-rest';
import { rm, timeAgo } from '../../lib/format';
import { useTableSort } from '../../lib/use-table-sort';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { depositStatusBadge } from '../../components/PaymentStatusBadge';

export const config: RouteConfig = {
  label: 'pcNav.deposits',
  translationNs: 'translation',
  rank: 1,
  nested: '/payments',
};

// Settled first and the default (2026-10-25): operators read unpaid and
// cancelled cashier sessions as a gateway fault, and TGPay files a customer's
// own cancel/timeout as 'failed'. The rest stay one click away for support
// ("I paid but got no credit"); the Overview's stuck-top-up row deep-links
// here with ?view=pending, which sorts oldest — i.e. stuck — first.
const VIEWS: GatewayDepositView[] = [
  'settled',
  'failed',
  'pending',
  'expired',
  'all',
];
const isView = (v: string | null): v is GatewayDepositView =>
  VIEWS.includes(v as GatewayDepositView);

// EXACTLY the backend's SORTABLE allow-list (api/admin/payments/deposits/
// route.ts) — real columns only. Customer and status are computed/joined
// server-side after the page is fetched, so those headers stay plain.
//
// `amount_settled`, NOT `settled_at`: the Credited column renders the AMOUNT
// credited, and a header must sort the value its own cells display.
type SortKey = 'created_at' | 'amount_requested' | 'amount_settled';

const DepositsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<GatewayDepositView>(() => {
    const asked = searchParams.get('view');
    return isView(asked) ? asked : 'settled';
  });
  // Starts NULL, not seeded: with no explicit sort the route orders pending
  // oldest-first (the work queue) and history views newest-first, and a seeded
  // default would silently flatten that. First header click opts in.
  const { sort, sortHeader } = useTableSort<SortKey>(null, {
    onChange: () => setPage(0),
  });
  const { data, isError } = useGatewayDeposits(
    page,
    view,
    sort ? `${sort.key}:${sort.dir}` : undefined,
  );

  // A view change restarts paging: page 3 of "pending" has nothing to do with
  // page 3 of "all", and keeping the offset lands the operator on an empty page.
  const changeView = (next: string) => {
    setView(next as GatewayDepositView);
    setPage(0);
  };

  const stuckOnPage = data?.deposits.filter((d) => d.stuck).length ?? 0;

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

        {stuckOnPage > 0 && (
          <div className="border-t px-6 py-3">
            <Text size="small" className="text-ui-fg-subtle">
              {/* `n`, not `count`: i18next treats `count` as a plural selector
                  and resolves suffixed keys before the base one. */}
              {t('deposits.stuckWarning', { n: stuckOnPage })}
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
                  {sortHeader('amount_settled', t('deposits.settled'), true)}
                  <Table.HeaderCell className="text-right">
                    {t('deposits.net')}
                  </Table.HeaderCell>
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
                      {d.gateway_amount !== null && d.currency !== 'MYR' && (
                        <div className="text-ui-fg-muted text-xs">
                          {t('deposits.paidIn', {
                            amount: `${d.currency} ${d.gateway_amount.toFixed(2)}`,
                          })}
                        </div>
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums whitespace-nowrap">
                      {d.amount_settled === null ? '—' : rm(d.amount_settled)}
                    </Table.Cell>
                    {/* NULL net = settled before the mirror: fee UNKNOWN, so
                        render —, never RM 0.00. */}
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums whitespace-nowrap">
                      {d.net_amount === null ? '—' : rm(d.net_amount)}
                    </Table.Cell>
                    <Table.Cell>
                      {depositStatusBadge(
                        d,
                        d.stuck
                          ? t('deposits.statusStuck')
                          : t(`deposits.statusLabel.${d.status}`),
                      )}
                    </Table.Cell>
                    {/* All references support can quote: ours (merchant) is
                        what their back office lists, theirs (gateway) is null
                        until SubmitDeposit returned, and the BANK's own refs
                        (settlement mirror) are what a bank quotes back in a
                        dispute — null on rows settled before the mirror. */}
                    <Table.Cell className="text-ui-fg-subtle font-mono text-xs break-all">
                      <div>{d.merchant_transaction_id}</div>
                      {d.gateway_transaction_id && (
                        <div className="text-ui-fg-muted">
                          {d.gateway_transaction_id}
                        </div>
                      )}
                      {d.bank_reference_no && (
                        <div className="text-ui-fg-muted">
                          {t('deposits.bankRef')}: {d.bank_reference_no}
                        </div>
                      )}
                      {d.unique_reference_no && (
                        <div className="text-ui-fg-muted">
                          {t('deposits.uniqueRef')}: {d.unique_reference_no}
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
