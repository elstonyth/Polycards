import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Table, Text } from '@medusajs/ui';
import {
  useCustomerGatewayDeposits,
  useCustomerGatewayWithdrawals,
} from '../../../lib/queries';
import type {
  GatewayDeposit,
  GatewayWithdrawal,
} from '../../../lib/admin-rest';
import { inCurrency, paymentMethodLabel, rm } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';
import {
  depositStatusBadge,
  withdrawalStatusBadge,
} from '../../../components/PaymentStatusBadge';
import {
  DetailDrawer,
  DetailRow,
  DetailRows,
  TableState,
  When,
  openableRow,
  whenText,
} from './bits';

const PAGE = 20;

/** Our own reference, cut to fit: the whole set is in the row's panel. */
const Ref = ({ value }: { value: string }) => (
  <div
    className="text-ui-fg-subtle txt-compact-xsmall max-w-[14rem] truncate font-mono"
    title={value}
  >
    {value}
  </div>
);

/** The three ids a payment can carry, labelled. Some gateways echo our own id
 *  back as theirs: that repeat is left out. */
const References = ({ row }: { row: GatewayDeposit | GatewayWithdrawal }) => {
  const { t } = useTranslation();
  const gateway =
    row.gateway_transaction_id !== row.merchant_transaction_id
      ? row.gateway_transaction_id
      : null;
  return (
    <>
      <DetailRow
        label={t('playerDetail.ourReference')}
        code={row.merchant_transaction_id}
      />
      <DetailRow label={t('playerDetail.gatewayReference')} code={gateway} />
      <DetailRow
        label={t('playerDetail.bankReference')}
        code={row.bank_reference_no}
      />
      <DetailRow
        label={t('playerDetail.uniqueReference')}
        code={row.unique_reference_no}
      />
    </>
  );
};

const paidIn = (row: GatewayDeposit | GatewayWithdrawal) =>
  row.gateway_amount !== null && row.currency !== 'MYR'
    ? inCurrency(row.gateway_amount, row.currency)
    : null;

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
  const [openDep, setOpenDep] = useState<GatewayDeposit | null>(null);
  const [openWd, setOpenWd] = useState<GatewayWithdrawal | null>(null);
  const deposits = useCustomerGatewayDeposits(customerId, depPage);
  const withdrawals = useCustomerGatewayWithdrawals(customerId, wdPage);
  const depRows = deposits.data?.deposits ?? [];
  const wdRows = withdrawals.data?.withdrawals ?? [];
  const depLabel = (d: GatewayDeposit) =>
    d.stuck ? t('deposits.statusStuck') : t(`deposits.statusLabel.${d.status}`);
  const wdLabel = (w: GatewayWithdrawal) =>
    w.stale && w.status === 'pending'
      ? t('withdrawals.statusStale')
      : t(`withdrawals.statusLabel.${w.status}`);

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
          <TableState
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
                    <Table.Row key={d.id} {...openableRow(() => setOpenDep(d))}>
                      <Table.Cell className="whitespace-nowrap">
                        <When iso={d.created_at} />
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        {paymentMethodLabel(d.payment_method_code)}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                        {rm(d.amount_requested)}
                        {paidIn(d) && (
                          <div className="text-ui-fg-subtle txt-compact-xsmall">
                            {t('deposits.paidIn', { amount: paidIn(d) })}
                          </div>
                        )}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                        {d.amount_settled === null ? '—' : rm(d.amount_settled)}
                      </Table.Cell>
                      <Table.Cell>
                        {depositStatusBadge(d, depLabel(d))}
                      </Table.Cell>
                      <Table.Cell>
                        <Ref value={d.merchant_transaction_id} />
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
          <TableState
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
                      {t('withdrawals.reference')}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {wdRows.map((w) => (
                    <Table.Row key={w.id} {...openableRow(() => setOpenWd(w))}>
                      <Table.Cell className="whitespace-nowrap">
                        <When iso={w.created_at} />
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        <div>{w.bank_name ?? w.bank_code}</div>
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
                      <Table.Cell className="max-w-[18rem]">
                        {withdrawalStatusBadge(w, wdLabel(w))}
                        {w.failure_reason && (
                          <div
                            className="text-ui-fg-subtle txt-compact-xsmall mt-1 line-clamp-2"
                            title={w.failure_reason}
                          >
                            {w.failure_reason}
                          </div>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Ref value={w.merchant_transaction_id} />
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

      {openDep && (
        <DetailDrawer
          title={t('playerPayments.topUpTitle')}
          onClose={() => setOpenDep(null)}
        >
          <DetailRows>
            <DetailRow
              label={t('deposits.status')}
              value={depositStatusBadge(openDep, depLabel(openDep))}
            />
            <DetailRow
              label={t('deposits.method')}
              value={paymentMethodLabel(openDep.payment_method_code)}
            />
            <DetailRow
              label={t('deposits.requested')}
              value={rm(openDep.amount_requested)}
            />
            <DetailRow
              label={t('playerDetail.paidIn')}
              value={paidIn(openDep)}
            />
            <DetailRow
              label={t('deposits.settled')}
              value={
                openDep.amount_settled === null
                  ? null
                  : rm(openDep.amount_settled)
              }
            />
            <DetailRow
              label={t('playerDetail.afterFee')}
              value={
                openDep.net_amount === null ? null : rm(openDep.net_amount)
              }
            />
            <DetailRow
              label={t('deposits.when')}
              value={whenText(openDep.created_at)}
            />
            <DetailRow
              label={t('playerDetail.settledAt')}
              value={whenText(openDep.settled_at)}
            />
          </DetailRows>
          <DetailRows>
            <References row={openDep} />
          </DetailRows>
        </DetailDrawer>
      )}

      {openWd && (
        <DetailDrawer
          title={t('playerPayments.withdrawalTitle')}
          onClose={() => setOpenWd(null)}
        >
          <DetailRows>
            <DetailRow
              label={t('withdrawals.status')}
              value={withdrawalStatusBadge(openWd, wdLabel(openWd))}
            />
            <DetailRow
              label={t('playerPayments.reason')}
              value={openWd.failure_reason}
            />
            <DetailRow
              label={t('withdrawals.amount')}
              value={rm(openWd.amount)}
            />
            <DetailRow
              label={t('playerDetail.paidIn')}
              value={paidIn(openWd)}
            />
            <DetailRow
              label={t('deposits.settled')}
              value={
                openWd.amount_settled === null
                  ? null
                  : rm(openWd.amount_settled)
              }
            />
            <DetailRow
              label={t('playerDetail.afterFee')}
              value={openWd.net_amount === null ? null : rm(openWd.net_amount)}
            />
            <DetailRow
              label={t('withdrawals.when')}
              value={whenText(openWd.created_at)}
            />
            <DetailRow
              label={t('playerDetail.settledAt')}
              value={whenText(openWd.settled_at)}
            />
          </DetailRows>
          <DetailRows>
            <DetailRow
              label={t('playerDetail.bank')}
              value={openWd.bank_name ?? openWd.bank_code}
            />
            <DetailRow
              label={t('players.bankAccount')}
              value={openWd.account_number}
            />
            <DetailRow
              label={t('playerDetail.holder')}
              value={openWd.account_holder_name}
            />
          </DetailRows>
          <DetailRows>
            <References row={openWd} />
          </DetailRows>
        </DetailDrawer>
      )}
    </>
  );
};
