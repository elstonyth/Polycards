import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Table, Text } from '@medusajs/ui';
import {
  useCustomerGatewayDeposits,
  useCustomerGatewayWithdrawals,
} from '../../../lib/queries';
import { orderDateTime, rm, timeAgo } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';
import {
  depositStatusBadge,
  withdrawalStatusBadge,
} from '../../../components/PaymentStatusBadge';

const PAGE = 20;

const When = ({ iso }: { iso: string }) => (
  <>
    <div className="tabular-nums">{orderDateTime(iso)}</div>
    <div className="text-ui-fg-subtle txt-compact-xsmall">{timeAgo(iso)}</div>
  </>
);

const Refs = ({ refs }: { refs: (string | null)[] }) => (
  <div className="max-w-[18rem]">
    {refs
      .filter((r): r is string => !!r)
      .map((r) => (
        <div
          key={r}
          className="text-ui-fg-subtle txt-compact-xsmall truncate font-mono"
          title={r}
        >
          {r}
        </div>
      ))}
  </div>
);

const State = ({ isError, empty }: { isError: boolean; empty: string }) => (
  <div className="border-t px-6 py-6">
    {isError ? (
      <Text size="small" className="text-ui-fg-error">
        Failed to load.
      </Text>
    ) : (
      <Text className="text-ui-fg-subtle">{empty}</Text>
    )}
  </div>
);

/**
 * Every gateway top-up and payout this player ever started, whatever became
 * of it — what support needs to answer "I paid, where is it?" or "where is my
 * withdrawal?": awaiting payment, cancelled / rejected, no gateway answer,
 * held, paid out or refunded. Read-only (the actions stay on the Deposits /
 * Withdrawals pages). The Wallet tab shows only what reached the ledger.
 */
export const PaymentsTab = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const [depPage, setDepPage] = useState(0);
  const [wdPage, setWdPage] = useState(0);
  const deposits = useCustomerGatewayDeposits(customerId, depPage);
  const withdrawals = useCustomerGatewayWithdrawals(customerId, wdPage);
  const depRows = deposits.data?.deposits ?? [];
  const wdRows = withdrawals.data?.withdrawals ?? [];

  return (
    <>
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('playerPayments.topUpsTitle')}</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {t('playerPayments.topUpsSubtitle')}
          </Text>
        </div>
        {deposits.isError || (deposits.data && depRows.length === 0) ? (
          <State
            isError={deposits.isError}
            empty={t('playerPayments.noTopUps')}
          />
        ) : !deposits.data ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : (
          <>
            <div
              className="overflow-x-auto border-t"
              tabIndex={0}
              role="region"
              aria-label={t('playerPayments.topUpsTitle')}
            >
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{t('deposits.when')}</Table.HeaderCell>
                    <Table.HeaderCell>{t('deposits.method')}</Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t('deposits.requested')}
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t('deposits.settled')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>{t('deposits.status')}</Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('deposits.reference')}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {depRows.map((d) => (
                    <Table.Row key={d.id}>
                      <Table.Cell className="whitespace-nowrap">
                        <When iso={d.created_at} />
                      </Table.Cell>
                      <Table.Cell>{d.payment_method_code}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                        {rm(d.amount_requested)}
                        {d.gateway_amount !== null && d.currency !== 'MYR' && (
                          <div className="text-ui-fg-subtle txt-compact-xsmall">
                            {t('deposits.paidIn', {
                              amount: `${d.currency} ${d.gateway_amount.toFixed(2)}`,
                            })}
                          </div>
                        )}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                        {d.amount_settled === null ? '—' : rm(d.amount_settled)}
                      </Table.Cell>
                      <Table.Cell>
                        {depositStatusBadge(
                          d,
                          d.stuck
                            ? t('deposits.statusStuck')
                            : t(`deposits.statusLabel.${d.status}`),
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Refs
                          refs={[
                            d.merchant_transaction_id,
                            d.gateway_transaction_id,
                            d.bank_reference_no,
                          ]}
                        />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
            <Pager
              page={depPage}
              onPage={setDepPage}
              pageSize={PAGE}
              count={depRows.length}
              total={deposits.data.total}
            />
          </>
        )}
      </Container>

      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('playerPayments.withdrawalsTitle')}</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {t('playerPayments.withdrawalsSubtitle')}
          </Text>
        </div>
        {withdrawals.isError || (withdrawals.data && wdRows.length === 0) ? (
          <State
            isError={withdrawals.isError}
            empty={t('playerPayments.noWithdrawals')}
          />
        ) : !withdrawals.data ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : (
          <>
            <div
              className="overflow-x-auto border-t"
              tabIndex={0}
              role="region"
              aria-label={t('playerPayments.withdrawalsTitle')}
            >
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{t('withdrawals.when')}</Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('withdrawals.destination')}
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t('withdrawals.amount')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('withdrawals.status')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('playerPayments.reason')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('withdrawals.reference')}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {wdRows.map((w) => (
                    <Table.Row key={w.id}>
                      <Table.Cell className="whitespace-nowrap">
                        <When iso={w.created_at} />
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        <div>{w.bank_code}</div>
                        <div className="text-ui-fg-subtle txt-compact-xsmall">
                          {w.account_number} · {w.account_holder_name}
                        </div>
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                        {rm(w.amount)}
                        {w.amount_settled !== null &&
                          w.amount_settled !== w.amount && (
                            <div className="text-ui-fg-subtle txt-compact-xsmall">
                              {t('withdrawals.settledAs', {
                                amount: rm(w.amount_settled),
                              })}
                            </div>
                          )}
                      </Table.Cell>
                      <Table.Cell>
                        {withdrawalStatusBadge(
                          w,
                          w.stale && w.status === 'pending'
                            ? t('withdrawals.statusStale')
                            : t(`withdrawals.statusLabel.${w.status}`),
                        )}
                      </Table.Cell>
                      <Table.Cell className="max-w-[16rem]">
                        <span
                          className="text-ui-fg-subtle txt-compact-xsmall"
                          title={w.failure_reason ?? undefined}
                        >
                          {w.failure_reason ?? '—'}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Refs
                          refs={[
                            w.merchant_transaction_id,
                            w.gateway_transaction_id,
                            w.bank_reference_no,
                          ]}
                        />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
            <Pager
              page={wdPage}
              onPage={setWdPage}
              pageSize={PAGE}
              count={wdRows.length}
              total={withdrawals.data.total}
            />
          </>
        )}
      </Container>
    </>
  );
};
