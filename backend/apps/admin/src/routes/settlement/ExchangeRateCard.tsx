import type { Permission } from '@mercurjs/dashboard-sdk';
import { usePermissions } from '@mercurjs/admin';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Container, Heading, Text } from '@medusajs/ui';
import { inCurrency, rm } from '../../lib/format';
import { FxEditDrawer } from './FxEditDrawer';
import { fmtRate, floorCents, usePaymentFx } from './fx-shared';

const Stat = ({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) => (
  <div className="bg-ui-bg-subtle flex flex-col gap-0.5 px-6 py-4">
    <Text size="small" className="text-ui-fg-subtle">
      {label}
    </Text>
    <Text size="xlarge" weight="plus" className="tabular-nums">
      {value}
    </Text>
    <Text size="xsmall" className="text-ui-fg-subtle">
      {note}
    </Text>
  </div>
);

/** A regional tab's exchange rate: four figures and one worked example. The
 *  fee and rate form opens in a side panel from "Edit rates". */
export const ExchangeRateCard = ({ currency }: { currency: string }) => {
  const { t } = useTranslation();
  // Writes here ask payment:update; a view-only role reads the figures only.
  const canEdit = usePermissions().hasPermission(
    'payment:update' as Permission,
  );
  const { data: fx, isError, isPending } = usePaymentFx(currency);
  const [editing, setEditing] = useState(false);
  const q = fx?.quote;
  const unit = fx?.unit ?? `1 ${currency}`;
  return (
    <Container
      className="p-0"
      data-testid={`fx-card-${currency}`}
      aria-busy={isPending}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div className="flex items-center gap-2">
          <Heading level="h2">{t('settlement.fxTitleShort')}</Heading>
          {isPending ? (
            <Badge color="grey" size="2xsmall">
              …
            </Badge>
          ) : q ? (
            <Badge color="green" size="2xsmall">
              {q.feeEnabled
                ? t('settlement.fxQuoting')
                : t('settlement.fxQuotingNoFee')}
            </Badge>
          ) : (
            <Badge color="red" size="2xsmall">
              {isError
                ? t('settlement.fxUnavailable')
                : t('settlement.fxPaused')}
            </Badge>
          )}
        </div>
        {canEdit && (
          <FxEditDrawer
            currency={currency}
            open={editing}
            onOpenChange={setEditing}
          >
            <Button size="small" variant="secondary" disabled={!fx}>
              {t('settlement.fxEdit')}
            </Button>
          </FxEditDrawer>
        )}
      </div>

      <div className="bg-ui-border-base grid grid-cols-1 gap-px border-t sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t('settlement.fxFeedRate')}
          value={fx?.feed_rate != null ? fmtRate(fx.feed_rate) : '—'}
          note={
            fx?.fetched_at
              ? t('settlement.fxSourceHint', {
                  source: t(`settlement.fxSource.${fx.source}`, {
                    defaultValue: fx.source ?? '',
                  }),
                  when: new Date(fx.fetched_at).toLocaleString('en-MY'),
                })
              : t('settlement.fxNotFetched')
          }
        />
        <Stat
          label={t('settlement.fxDepositRateShort')}
          value={q ? `RM ${fmtRate(q.depositRate)}` : '—'}
          note={
            q
              ? t('settlement.fxPerUnitFee', {
                  unit,
                  sign: '−',
                  pct: q.depositFeePercent,
                })
              : ''
          }
        />
        <Stat
          label={t('settlement.fxPayoutRateShort')}
          value={q ? `RM ${fmtRate(q.payoutRate)}` : '—'}
          note={
            q
              ? t('settlement.fxPerUnitFee', {
                  unit,
                  sign: '+',
                  pct: q.payoutFeePercent,
                })
              : ''
          }
        />
        <Stat
          label={t('settlement.fxEarned')}
          value={fx ? rm(fx.earnings.total_rm) : '—'}
          note={
            fx
              ? t('settlement.fxEarnedHint', {
                  deposits: fx.earnings.deposits.count,
                  payouts: fx.earnings.payouts.count,
                })
              : ''
          }
        />
      </div>
      {q ? (
        <Text size="small" className="text-ui-fg-subtle border-t px-6 py-3">
          {t('settlement.fxExample', {
            topup: inCurrency(100, currency),
            credit: rm(floorCents(100 * q.depositRate)),
            paid: inCurrency(floorCents(100 / q.payoutRate), currency),
          })}
        </Text>
      ) : null}
      {fx?.quote_error && (
        <Text className="text-ui-fg-error border-t px-6 py-3" size="small">
          {t('settlement.fxQuoteError', { error: fx.quote_error, currency })}
        </Text>
      )}
    </Container>
  );
};
