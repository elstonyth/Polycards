import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Container,
  Heading,
  Table,
  Text,
  Tooltip,
} from '@medusajs/ui';
import { useSettlementReport } from '../../lib/queries';
import type { SettlementGranularity } from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// The gateway's calendar weekly/monthly result for one currency, read from
// this database (audit 2026-08-17 B1/B3/B4/B5), so the operator never has to
// log into the gateway's back office for "what did this month do": settled
// gross, the fee they kept, the net, and — because two records of the same
// money exist — the delta against the credit ledger's own view of the same
// period. Always RM, the ledger's currency: a regional payment counts at the
// rate it locked.

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

/** A sum that is a FLOOR ("≥ x", with the reason on hover) when `missing`
 *  settled rows had no figure on file. */
const floor = (value: number, missing: number, hint: string): ReactNode =>
  missing > 0 ? (
    <Tooltip content={hint}>
      <span>≥ {rm(value)}</span>
    </Tooltip>
  ) : (
    rm(value)
  );

export const ReportCard = ({ currency }: { currency: string }) => {
  const { t } = useTranslation();
  const [granularity, setGranularity] =
    useState<SettlementGranularity>('month');
  const { data, isError } = useSettlementReport(granularity, 12, currency);

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
  const feeHint = (count: number) => t('settlement.feeFloorHint', { count });

  return (
    <Container className="p-0" data-testid={`report-card-${currency}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
        <div>
          <Heading level="h2">{t('settlement.reportTitle')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {currency === 'MYR'
              ? t('settlement.reportSubtitle')
              : t('settlement.reportSubtitleRegional', { currency })}
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

      {isError ? (
        <Text className="text-ui-fg-subtle border-t px-6 py-8">
          {t('settlement.loadError')}
        </Text>
      ) : !data ? (
        <div className="border-t px-6 py-8">
          <LoadingSkeleton />
        </div>
      ) : data.periods.length === 0 ? (
        <Text className="text-ui-fg-subtle border-t px-6 py-8">
          {t('settlement.empty')}
        </Text>
      ) : (
        <>
          <div className="overflow-x-auto border-t">
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
                  {(['deposit', 'withdrawal'] as const).map((side) => (
                    <DirectionHeads key={side} side={side} />
                  ))}
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
                      {floor(
                        p.deposits.gross,
                        p.deposits.missingGross,
                        t('settlement.grossFloorHint', {
                          count: p.deposits.missingGross,
                        }),
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {floor(
                        p.deposits.fee,
                        p.deposits.missingNet,
                        feeHint(p.deposits.missingNet),
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
                      {floor(
                        p.withdrawals.fee,
                        p.withdrawals.missingNet,
                        feeHint(p.withdrawals.missingNet),
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
          </div>
          {missingNetTotal > 0 || missingGrossTotal > 0 ? (
            <div className="flex flex-wrap gap-2 border-t px-6 py-3">
              {missingNetTotal > 0 ? (
                <Badge size="2xsmall" color="orange">
                  {feeHint(missingNetTotal)}
                </Badge>
              ) : null}
              {missingGrossTotal > 0 ? (
                <Badge size="2xsmall" color="orange">
                  {t('settlement.grossFloorHint', {
                    count: missingGrossTotal,
                  })}
                </Badge>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Container>
  );
};

const DirectionHeads = ({ side }: { side: 'deposit' | 'withdrawal' }) => {
  const { t } = useTranslation();
  return (
    <>
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
        <Tooltip content={t(`settlement.${side}DeltaHint`)}>
          <span>{t('settlement.delta')}</span>
        </Tooltip>
      </Table.HeaderCell>
    </>
  );
};
