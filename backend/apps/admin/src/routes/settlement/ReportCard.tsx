import { useState } from 'react';
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
import { LEDGER_CURRENCY, rm } from '../../lib/format';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Hint } from '../../components/Hint';
import { resultRow } from './settlement-rows';

// The gateway's calendar weekly/monthly result for one currency, read from
// this database (audit 2026-08-17 B1/B3/B4/B5), so the operator never has to
// log into the gateway's back office for "what did this month do": money in,
// the fees, money out, the net — and, because two records of the same money
// exist, a check against the credit ledger's own view of the period. Always
// RM, the ledger's currency: a regional payment counts at the rate it locked.

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

export const ReportCard = ({ currency }: { currency: string }) => {
  const { t } = useTranslation();
  const [granularity, setGranularity] =
    useState<SettlementGranularity>('month');
  const { data, isError } = useSettlementReport(granularity, 12, currency);
  const rows = (data?.periods ?? []).map(resultRow);
  const feeFloors = rows.filter((r) => r.feeFloor).length;
  const grossFloors = rows.filter((r) => r.grossFloor).length;

  // "≥ x" with the reason on hover when some rows had no figure on file.
  const floor = (value: number, isFloor: boolean, hint: string) =>
    isFloor ? (
      <Tooltip content={hint}>
        <span>≥ {rm(value)}</span>
      </Tooltip>
    ) : (
      rm(value)
    );

  return (
    <Container className="p-0" data-testid={`report-card-${currency}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
        <div>
          <Heading level="h2">
            {t(
              granularity === 'month'
                ? 'settlement.reportTitleMonth'
                : 'settlement.reportTitleWeek',
            )}
          </Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {currency === LEDGER_CURRENCY
              ? t('settlement.reportSubtitleShort')
              : t('settlement.reportSubtitleShortRegional')}
          </Text>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['month', 'week'] as const).map((g) => (
            <Button
              key={g}
              size="small"
              variant={granularity === g ? 'primary' : 'secondary'}
              aria-pressed={granularity === g}
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
      ) : rows.length === 0 ? (
        <Text className="text-ui-fg-subtle border-t px-6 py-8">
          {t('settlement.empty')}
        </Text>
      ) : (
        <>
          <div className="overflow-x-auto border-t">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('settlement.period')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('settlement.moneyIn')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('settlement.fees')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('settlement.moneyOut')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('settlement.netCash')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    <span className="inline-flex items-center gap-1.5">
                      {t('settlement.ledgerCheck')}
                      <Hint
                        text={`${t('settlement.depositDeltaHint')} ${t('settlement.withdrawalDeltaHint')}`}
                      />
                    </span>
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((r) => (
                  <Table.Row key={r.period}>
                    <Table.Cell className="whitespace-nowrap font-medium">
                      {periodLabel(r.period, data.granularity)}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {floor(
                        r.inGross,
                        r.grossFloor,
                        t('settlement.grossFloorFootnote'),
                      )}
                      <Text
                        as="span"
                        size="xsmall"
                        className="text-ui-fg-muted block"
                      >
                        {t('settlement.topupsCount', { count: r.inCount })}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {floor(
                        r.fees,
                        r.feeFloor,
                        t('settlement.feeFloorFootnote'),
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {rm(r.outGross)}
                      <Text
                        as="span"
                        size="xsmall"
                        className="text-ui-fg-muted block"
                      >
                        {t('settlement.payoutsCount', { count: r.outCount })}
                      </Text>
                    </Table.Cell>
                    <Table.Cell
                      className={`text-right tabular-nums ${
                        r.net > 0
                          ? 'text-ui-tag-green-text'
                          : r.net < 0
                            ? 'text-ui-fg-error'
                            : ''
                      }`}
                    >
                      {rm(r.net)}
                    </Table.Cell>
                    <Table.Cell>
                      {r.gap === 0 ? (
                        <span className="text-ui-tag-green-text inline-flex items-center gap-1">
                          ✓
                          <Text
                            as="span"
                            size="small"
                            className="text-ui-fg-muted"
                          >
                            {t('settlement.matches')}
                          </Text>
                        </span>
                      ) : (
                        <Badge
                          size="2xsmall"
                          color="orange"
                          className="tabular-nums"
                        >
                          {t('settlement.gap', {
                            amount: `${r.gap > 0 ? '+' : ''}${rm(r.gap)}`,
                          })}
                        </Badge>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          {feeFloors > 0 || grossFloors > 0 ? (
            <div className="flex flex-wrap gap-2 border-t px-6 py-3">
              {feeFloors > 0 ? (
                <Text size="xsmall" className="text-ui-fg-muted">
                  {t('settlement.feeFloorFootnote')}
                </Text>
              ) : null}
              {grossFloors > 0 ? (
                <Text size="xsmall" className="text-ui-fg-muted">
                  {t('settlement.grossFloorFootnote')}
                </Text>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Container>
  );
};
