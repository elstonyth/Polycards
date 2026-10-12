import { useTranslation } from 'react-i18next';
import { Badge, Container, Heading, Table, Text, Tooltip } from '@medusajs/ui';
import { useGatewayAudit } from '../../lib/queries';
import { rm } from '../../lib/format';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// Gateway audit (plan 130) for one currency — the gateway is the source of
// truth for money in/out; this is where its disagreements with our rows
// surface. Our all-time settled totals sit here; the gateway's live wallet is
// at the top of the tab (RailCard), read once.

export const AuditCard = ({ currency }: { currency: string }) => {
  const { t } = useTranslation();
  const audit = useGatewayAudit(currency);

  /** One money figure, rendered as a FLOOR ("≥ x" with the same tooltip
   *  hint the report's fee column uses) when `missing` rows were excluded
   *  from the sum behind it. */
  const money = (
    value: number,
    missing = 0,
    hint: 'feeFloorHint' | 'grossFloorHint' = 'feeFloorHint',
  ) => {
    if (missing <= 0) return rm(value);
    return (
      <Tooltip content={t(`settlement.${hint}`, { count: missing })}>
        <span>≥ {rm(value)}</span>
      </Tooltip>
    );
  };

  return (
    <Container className="p-0" data-testid={`audit-card-${currency}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
        <div>
          <Heading level="h2">{t('settlement.auditTitle')}</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            {t('settlement.auditSubtitle')}
          </Text>
        </div>
        {audit.data?.findings_total ? (
          <Badge size="small" color="red">
            {t('settlement.auditFindings', {
              count: audit.data.findings_total,
            })}
          </Badge>
        ) : audit.data?.last_audited_at ? (
          <Badge size="small" color="green">
            {t('settlement.auditNoFindings')}
          </Badge>
        ) : null}
      </div>
      {audit.isError ? (
        <Text size="small" className="text-ui-fg-error border-t px-6 py-3">
          {t('settlement.auditLoadError')}
        </Text>
      ) : !audit.data ? (
        <div className="border-t px-6 py-8">
          <LoadingSkeleton />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-px border-t bg-ui-border-base sm:grid-cols-2">
            {(
              [
                [
                  'auditOurDeposits',
                  // Net first, then gross — and each is a FLOOR when its own
                  // counter is non-zero: a settled deposit with no net on
                  // file is excluded from Σnet, one settled by hand with no
                  // amount_settled is excluded from Σgross.
                  audit.data.totals.deposits.count,
                  money(
                    audit.data.totals.deposits.net,
                    audit.data.totals.deposits.missing_net,
                  ),
                  money(
                    audit.data.totals.deposits.gross,
                    audit.data.totals.deposits.missing_gross,
                    'grossFloorHint',
                  ),
                ],
                [
                  'auditOurWithdrawals',
                  // Gross (what customers were debited) beside net (what the
                  // payout wallet actually paid, fee included) — the number
                  // to hold against the gateway's payout wallet.
                  audit.data.totals.withdrawals.count,
                  money(audit.data.totals.withdrawals.gross),
                  money(
                    audit.data.totals.withdrawals.net,
                    audit.data.totals.withdrawals.missing_net,
                  ),
                ],
              ] as const
            ).map(([key, count, value, secondary]) => (
              <div key={key} className="bg-ui-bg-subtle px-6 py-3">
                <Text size="small" className="text-ui-fg-subtle">
                  {t(`settlement.${key}`, { count })}
                </Text>
                <Heading level="h3" className="mt-0.5 tabular-nums">
                  {value}
                  <span className="text-ui-fg-muted"> / {secondary}</span>
                </Heading>
              </div>
            ))}
          </div>
          {audit.data.history.map((h) => (
            <Text
              key={h.gateway}
              size="small"
              className="text-ui-fg-subtle border-t px-6 py-3"
            >
              {t('settlement.auditHistory', {
                gateway: h.gateway,
                deposits: h.deposits.count,
                depositsGross: rm(h.deposits.gross),
                withdrawals: h.withdrawals.count,
                withdrawalsGross: rm(h.withdrawals.gross),
              })}
            </Text>
          ))}
          <Text size="small" className="text-ui-fg-subtle border-t px-6 py-3">
            {audit.data.last_audited_at
              ? t('settlement.auditLastRun', {
                  when: new Date(audit.data.last_audited_at).toLocaleString(),
                })
              : t('settlement.auditNeverRun')}
          </Text>
          {audit.data.findings.length > 0 ? (
            <div className="overflow-x-auto border-t">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>
                      {t('settlement.auditKind')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('settlement.auditRef')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('settlement.auditCustomer')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('settlement.auditStatus')}
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t('settlement.auditAmount')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('settlement.auditNote')}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {audit.data.findings.map((f) => (
                    <Table.Row key={`${f.kind}-${f.id}`}>
                      <Table.Cell>
                        {f.kind}
                        <span className="text-ui-fg-muted"> · {f.gateway}</span>
                      </Table.Cell>
                      <Table.Cell className="font-mono text-xs">
                        {f.gateway_transaction_id ?? f.merchant_transaction_id}
                      </Table.Cell>
                      <Table.Cell className="font-mono text-xs">
                        {f.customer_id}
                      </Table.Cell>
                      <Table.Cell>{f.status}</Table.Cell>
                      <Table.Cell className="text-right tabular-nums">
                        {f.amount === null ? '—' : rm(f.amount)}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-error">
                        {f.note}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          ) : null}
        </>
      )}
    </Container>
  );
};
