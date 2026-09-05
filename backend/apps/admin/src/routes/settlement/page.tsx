import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  RadioGroup,
  Table,
  Text,
  Tooltip,
  usePrompt,
} from '@medusajs/ui';
import { Receipt } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useGatewayAudit,
  useGlobePayBalance,
  usePaymentGateway,
  useSavePaymentGateway,
  useSettlementReport,
} from '../../lib/queries';
import type {
  PaymentGatewayId,
  SettlementGranularity,
} from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// Settlement — the gateway's calendar weekly/monthly result, read from this
// database (audit 2026-08-17 B1/B3/B4/B5). This page exists so the operator
// never has to log into GlobePay365's back office for "what did this month
// do": settled gross, the fee they kept, the net, and — because two records of
// the same money exist — the delta against the credit ledger's own view of
// the same period. Plus the live merchant balance (the payout float).
export const config: RouteConfig = {
  label: 'Settlement',
  icon: Receipt,
  // After the Economy (30) / Ledger (31) money-reporting cluster. NOT 32 —
  // Daily rewards already holds that and a collision leaves the order
  // tie-break-dependent; 34 sits after Weekly Challenge (33) in a slot
  // nothing owns.
  rank: 34,
};

// MYT bucket key ('YYYY-MM-DD', first day of the week/month) → label. Month
// keys render as 'Aug 2026'; week keys as their Monday date, which is how an
// operator quotes a week to the provider.
const periodLabel = (
  key: string,
  granularity: SettlementGranularity,
): string => {
  if (granularity === 'month') {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-MY', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  return key;
};

// Deltas within a cent of zero render quiet; anything larger is the signal
// this column exists for. Withdrawal deltas are timing-skewed by design
// (debit at submit, settle later), so they get the subtle tone, not the
// alarm one — the tooltip carries the reading instructions.
const deltaCell = (value: number, alarming: boolean) => {
  if (Math.abs(value) < 0.005) {
    return <span className="text-ui-fg-muted">—</span>;
  }
  return (
    <span className={alarming ? 'text-ui-fg-error' : 'text-ui-fg-subtle'}>
      {value > 0 ? '+' : ''}
      {rm(value)}
    </span>
  );
};

const SettlementPage = () => {
  const { t } = useTranslation();
  const [granularity, setGranularity] =
    useState<SettlementGranularity>('month');
  const { data, isError } = useSettlementReport(granularity, 12);
  const balance = useGlobePayBalance();
  const audit = useGatewayAudit();
  const gateway = usePaymentGateway();
  const saveGateway = useSavePaymentGateway();
  const prompt = usePrompt();
  const [chosen, setChosen] = useState<PaymentGatewayId | null>(null);
  const [gatewayReason, setGatewayReason] = useState('');
  const activeGateway = gateway.data?.active ?? null;
  const wantedGateway = chosen ?? activeGateway;
  const gatewayDirty =
    wantedGateway !== null && wantedGateway !== activeGateway;
  const canSwitch =
    gatewayDirty && !saveGateway.isPending && gatewayReason.trim().length > 0;
  const switchGateway = async () => {
    if (!canSwitch || !wantedGateway) return;
    const label =
      gateway.data?.gateways.find((g) => g.id === wantedGateway)?.label ??
      wantedGateway;
    const confirmed = await prompt({
      title: t('settlement.gatewayTitle'),
      description: t('settlement.gatewayConfirm', { label }),
      confirmText: t('settlement.gatewaySave'),
    });
    if (!confirmed) return;
    saveGateway.mutate(
      { gateway: wantedGateway, reason: gatewayReason.trim() },
      {
        onSuccess: () => {
          setChosen(null);
          setGatewayReason('');
        },
      },
    );
  };

  const missingNetTotal = (data?.periods ?? []).reduce(
    (sum, p) => sum + p.deposits.missingNet + p.withdrawals.missingNet,
    0,
  );
  // Deposits only — withdrawals' missingGross is structurally 0 (its gross
  // basis, `amount`, is never NULL), so there is nothing to total there.
  const missingGrossTotal = (data?.periods ?? []).reduce(
    (sum, p) => sum + p.deposits.missingGross,
    0,
  );

  return (
    <div className="flex flex-col gap-y-3">
      {/* Active payment gateway (plan 130 §runtime switch). Sits above the
          report because everything below it is "the gateway's" numbers. */}
      <Container className="p-0">
        <div className="flex flex-col gap-1 px-6 py-4">
          <Heading level="h2">{t('settlement.gatewayTitle')}</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {t('settlement.gatewaySubtitle')}
          </Text>
        </div>
        {gateway.isError ? (
          <div className="border-t px-6 py-3">
            <Text size="small" className="text-ui-fg-error">
              {t('settlement.gatewayLoadError')}
            </Text>
          </div>
        ) : !gateway.data ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : (
          <div className="flex flex-col gap-4 border-t px-6 py-4">
            <div className="flex items-center gap-3">
              <Badge size="2xsmall" color="blue">
                {t('settlement.gatewayActive', {
                  label:
                    gateway.data.gateways.find(
                      (g) => g.id === gateway.data?.active,
                    )?.label ?? gateway.data.active,
                })}
              </Badge>
              {gateway.data.setting === null ? (
                <Text size="small" className="text-ui-fg-subtle">
                  ({t('settlement.gatewayEnvDefault')})
                </Text>
              ) : null}
            </div>
            <RadioGroup
              value={wantedGateway ?? undefined}
              onValueChange={(value) => setChosen(value as PaymentGatewayId)}
              className="flex flex-col gap-2"
            >
              {gateway.data.gateways.map((g) => (
                <label
                  key={g.id}
                  className="flex items-center gap-3"
                  htmlFor={`gateway-${g.id}`}
                >
                  <RadioGroup.Item
                    id={`gateway-${g.id}`}
                    value={g.id}
                    disabled={!g.configured}
                  />
                  <Text size="small" weight="plus">
                    {g.label}
                  </Text>
                  {!g.configured ? (
                    <Text size="small" className="text-ui-fg-muted">
                      {t('settlement.gatewayNotConfigured')}
                    </Text>
                  ) : null}
                </label>
              ))}
            </RadioGroup>
            <div className="flex items-end gap-4">
              <div className="flex min-w-64 flex-1 flex-col gap-y-1">
                <Text size="small" weight="plus">
                  {t('settlement.gatewayReason')}
                </Text>
                <Input
                  value={gatewayReason}
                  onChange={(e) => setGatewayReason(e.target.value)}
                  placeholder={t('settlement.gatewayReasonPlaceholder')}
                  disabled={!gatewayDirty}
                />
              </div>
              <Button
                onClick={switchGateway}
                isLoading={saveGateway.isPending}
                disabled={!canSwitch}
              >
                {t('settlement.gatewaySave')}
              </Button>
            </div>
          </div>
        )}
      </Container>

      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
          <div>
            <Heading level="h2">{t('settlement.title')}</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t('settlement.subtitle')}
            </Text>
          </div>
          <div className="flex flex-wrap gap-1">
            {(['month', 'week'] as const).map((g) => (
              <Button
                key={g}
                size="small"
                variant={granularity === g ? 'primary' : 'secondary'}
                onClick={() => setGranularity(g)}
              >
                {t(`settlement.${g}`)}
              </Button>
            ))}
          </div>
        </div>

        {/* Merchant balance strip — its own endpoint, so a gateway outage
            degrades this strip and never the report below it. */}
        <div className="grid grid-cols-3 gap-px border-t bg-ui-border-base">
          {/* Three degraded states, each distinct: gateway unconfigured
              (enabled:false), gateway unreachable (200 + error), and OUR
              endpoint failing (isError — expired session, network). Without
              the last one the tiles pin at '…' forever, indistinguishable
              from loading. */}
          {balance.isError ? (
            <div className="col-span-3 bg-ui-bg-subtle px-6 py-3">
              <Text size="small" className="text-ui-fg-error">
                {t('settlement.balanceError', {
                  message: t('settlement.balanceFetchFailed'),
                })}
              </Text>
            </div>
          ) : balance.data?.enabled === false ? (
            <div className="col-span-3 bg-ui-bg-subtle px-6 py-3">
              <Text size="small" className="text-ui-fg-subtle">
                {t('settlement.balanceDisabled')}
              </Text>
            </div>
          ) : balance.data?.error ? (
            <div className="col-span-3 bg-ui-bg-subtle px-6 py-3">
              <Text size="small" className="text-ui-fg-error">
                {t('settlement.balanceError', {
                  message: balance.data.error,
                })}
              </Text>
            </div>
          ) : (
            (
              [
                ['balanceAvailable', balance.data?.balance?.available],
                ['balanceCurrent', balance.data?.balance?.current],
                ['balanceT1', balance.data?.balance?.t1],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="bg-ui-bg-subtle px-6 py-3">
                <Text size="small" className="text-ui-fg-subtle">
                  {t(`settlement.${key}`)}
                </Text>
                <Heading level="h2" className="mt-0.5 tabular-nums">
                  {value === undefined ? '…' : rm(value)}
                </Heading>
              </div>
            ))
          )}
        </div>
      </Container>

      <Container className="p-0">
        {isError ? (
          <div className="px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {t('settlement.loadError')}
            </Text>
          </div>
        ) : !data ? (
          <div className="px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : data.periods.length === 0 ? (
          <div className="px-6 py-8">
            <Text className="text-ui-fg-subtle">{t('settlement.empty')}</Text>
          </div>
        ) : (
          <>
            <Table>
              <Table.Header>
                {/* Group row: one visual bracket per money direction. */}
                <Table.Row>
                  <Table.HeaderCell />
                  <Table.HeaderCell
                    colSpan={5}
                    className="border-l text-center"
                  >
                    {t('settlement.depositsGroup')}
                  </Table.HeaderCell>
                  <Table.HeaderCell
                    colSpan={5}
                    className="border-l text-center"
                  >
                    {t('settlement.withdrawalsGroup')}
                  </Table.HeaderCell>
                </Table.Row>
                <Table.Row>
                  <Table.HeaderCell>{t('settlement.period')}</Table.HeaderCell>
                  <Table.HeaderCell className="border-l text-right">
                    {t('settlement.count')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('settlement.gross')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('settlement.fee')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('settlement.net')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    <Tooltip content={t('settlement.depositDeltaHint')}>
                      <span>{t('settlement.delta')}</span>
                    </Tooltip>
                  </Table.HeaderCell>
                  <Table.HeaderCell className="border-l text-right">
                    {t('settlement.count')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('settlement.gross')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('settlement.fee')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('settlement.net')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    <Tooltip content={t('settlement.withdrawalDeltaHint')}>
                      <span>{t('settlement.delta')}</span>
                    </Tooltip>
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.periods.map((p) => (
                  <Table.Row key={p.period}>
                    <Table.Cell className="whitespace-nowrap font-medium">
                      {periodLabel(p.period, data.granularity)}
                    </Table.Cell>
                    <Table.Cell className="border-l text-right tabular-nums">
                      {p.deposits.count || '—'}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {p.deposits.missingGross > 0 ? (
                        <Tooltip
                          content={t('settlement.grossFloorHint', {
                            count: p.deposits.missingGross,
                          })}
                        >
                          <span>≥ {rm(p.deposits.gross)}</span>
                        </Tooltip>
                      ) : (
                        rm(p.deposits.gross)
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {p.deposits.missingNet > 0 ? (
                        <Tooltip
                          content={t('settlement.feeFloorHint', {
                            count: p.deposits.missingNet,
                          })}
                        >
                          <span>≥ {rm(p.deposits.fee)}</span>
                        </Tooltip>
                      ) : (
                        rm(p.deposits.fee)
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {rm(p.deposits.net)}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {deltaCell(p.delta.deposits, true)}
                    </Table.Cell>
                    <Table.Cell className="border-l text-right tabular-nums">
                      {p.withdrawals.count || '—'}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {rm(p.withdrawals.gross)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {p.withdrawals.missingNet > 0 ? (
                        <Tooltip
                          content={t('settlement.feeFloorHint', {
                            count: p.withdrawals.missingNet,
                          })}
                        >
                          <span>≥ {rm(p.withdrawals.fee)}</span>
                        </Tooltip>
                      ) : (
                        rm(p.withdrawals.fee)
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {rm(p.withdrawals.net)}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {deltaCell(p.delta.withdrawals, false)}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
            {missingNetTotal > 0 && (
              <div className="border-t px-6 py-3">
                <Badge size="2xsmall" color="orange">
                  {t('settlement.feeFloorHint', { count: missingNetTotal })}
                </Badge>
              </div>
            )}
            {missingGrossTotal > 0 && (
              <div className="border-t px-6 py-3">
                <Badge size="2xsmall" color="orange">
                  {t('settlement.grossFloorHint', {
                    count: missingGrossTotal,
                  })}
                </Badge>
              </div>
            )}
          </>
        )}
      </Container>

      {/* Gateway audit (plan 130) — the gateway is the source of truth for
          money in/out; this is where its disagreements with our rows surface.
          Own endpoint, so a gateway outage degrades the wallet tiles only. */}
      <Container className="p-0">
        <div className="flex flex-col gap-1 px-6 py-4">
          <Heading level="h2">{t('settlement.auditTitle')}</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {t('settlement.auditSubtitle')}
          </Text>
        </div>
        {audit.isError ? (
          <div className="border-t px-6 py-3">
            <Text size="small" className="text-ui-fg-error">
              {t('settlement.auditLoadError')}
            </Text>
          </div>
        ) : !audit.data ? (
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-px border-t bg-ui-border-base md:grid-cols-4">
              {(
                [
                  ['auditWalletPayin', audit.data.wallet?.current],
                  ['auditWalletPayout', audit.data.wallet?.available],
                  [
                    'auditOurDeposits',
                    audit.data.totals.deposits.net,
                    audit.data.totals.deposits.gross,
                  ],
                  ['auditOurWithdrawals', audit.data.totals.withdrawals.gross],
                ] as const
              ).map(([key, value, secondary]) => (
                <div key={key} className="bg-ui-bg-subtle px-6 py-3">
                  <Text size="small" className="text-ui-fg-subtle">
                    {t(`settlement.${key}`)}
                  </Text>
                  <Heading level="h3" className="mt-0.5 tabular-nums">
                    {value === undefined || value === null ? '—' : rm(value)}
                    {secondary !== undefined ? (
                      <span className="text-ui-fg-muted">
                        {' '}
                        / {rm(secondary)}
                      </span>
                    ) : null}
                  </Heading>
                </div>
              ))}
            </div>
            {audit.data.wallet_error ? (
              <div className="border-t px-6 py-3">
                <Text size="small" className="text-ui-fg-error">
                  {t('settlement.balanceError', {
                    message: audit.data.wallet_error,
                  })}
                </Text>
              </div>
            ) : null}
            <div className="flex items-center gap-3 border-t px-6 py-3">
              <Text size="small" className="text-ui-fg-subtle">
                {audit.data.last_audited_at
                  ? t('settlement.auditLastRun', {
                      when: new Date(
                        audit.data.last_audited_at,
                      ).toLocaleString(),
                    })
                  : t('settlement.auditNeverRun')}
              </Text>
              {audit.data.findings_total > 0 ? (
                <Badge size="2xsmall" color="red">
                  {t('settlement.auditFindings', {
                    count: audit.data.findings_total,
                  })}
                </Badge>
              ) : audit.data.last_audited_at ? (
                <Badge size="2xsmall" color="green">
                  {t('settlement.auditNoFindings')}
                </Badge>
              ) : null}
            </div>
            {audit.data.findings.length > 0 ? (
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
                      <Table.Cell>{f.kind}</Table.Cell>
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
            ) : null}
          </>
        )}
      </Container>
    </div>
  );
};

export default SettlementPage;
