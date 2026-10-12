import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Switch,
  Text,
  toast,
  usePrompt,
} from '@medusajs/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getPaymentFx, setPaymentFx } from '../../lib/admin-rest';
import { rm } from '../../lib/format';

// A regional rail's conversion (A3Pay: SGD): the market rate into RM and OUR
// markup on it. Customers pay and are paid in that currency; the ledger stays
// in RM. A top-up credits at market - markup, a payout pays at market +
// markup, and the difference is what the conversion earns. Every payment
// locks the rate it was quoted at, so a change here only affects payments
// started AFTER it is saved.

const fmt = (n: number, dp = 4) => n.toFixed(dp);
const floorCents = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

export const RegionalFxCard = ({ currency }: { currency: string }) => {
  const { t } = useTranslation();
  const key = ['payment-fx', currency] as const;
  const qc = useQueryClient();
  const prompt = usePrompt();
  const { data: fx, isError } = useQuery({
    queryKey: key,
    queryFn: () => getPaymentFx(currency),
  });
  const save = useMutation({
    mutationFn: setPaymentFx,
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      toast.success(t('settlement.fxSaved', { currency }));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const [seeded, setSeeded] = useState(false);
  const [markup, setMarkup] = useState('');
  const [override, setOverride] = useState(false);
  const [manualRate, setManualRate] = useState('');
  const [reason, setReason] = useState('');
  if (fx && !seeded) {
    setSeeded(true);
    setMarkup(String(fx.markup));
    setOverride(fx.manual_override);
    setManualRate(fx.manual_rate != null ? String(fx.manual_rate) : '');
  }

  // Live preview of what a customer gets with the values as typed. The band
  // is the backend's (PAYMENT_FX_FEEDS), so the preview and the save agree.
  const unit = fx?.unit ?? `1 ${currency}`;
  const mid = override ? Number(manualRate) : (fx?.feed_rate ?? NaN);
  const m = Number(markup);
  const midOk =
    Number.isFinite(mid) &&
    mid > 0 &&
    (!override ||
      ((fx?.manual_band.min == null || mid >= fx.manual_band.min) &&
        (fx?.manual_band.max == null || mid <= fx.manual_band.max)));
  const markupOk =
    markup.trim() !== '' &&
    Number.isFinite(m) &&
    m >= 0 &&
    midOk &&
    m <= mid * (fx?.max_markup_share ?? 0.2);
  const depositRate = midOk && markupOk ? mid - m : null;
  const payoutRate = midOk && markupOk ? mid + m : null;
  const canSave =
    !save.isPending && midOk && markupOk && reason.trim().length > 0;

  const submit = async () => {
    if (!canSave || depositRate === null || payoutRate === null) return;
    const confirmed = await prompt({
      title: t('settlement.fxConfirmTitle', { currency }),
      description: t('settlement.fxConfirm', {
        currency,
        unit,
        deposit: fmt(depositRate),
        payout: fmt(payoutRate),
      }),
      confirmText: t('settlement.fxSave'),
      variant: 'confirmation',
    });
    if (!confirmed) return;
    save.mutate(
      {
        currency,
        markup: m,
        manual_override: override,
        manual_rate: override ? Number(manualRate) : null,
        reason: reason.trim(),
      },
      { onSuccess: () => setReason('') },
    );
  };

  const id = (field: string) => `fx-${currency.toLowerCase()}-${field}`;
  return (
    <Container className="p-0" data-testid={`fx-card-${currency}`}>
      <div className="flex items-start justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">{t('settlement.fxTitle', { currency })}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('settlement.fxSubtitle', { currency, unit })}
          </Text>
        </div>
        {fx?.quote ? (
          <Badge color="green" size="small">
            {t('settlement.fxQuoting')}
          </Badge>
        ) : (
          <Badge color="red" size="small">
            {isError ? t('settlement.fxUnavailable') : t('settlement.fxPaused')}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 border-t px-6 py-4 md:grid-cols-4">
        <Stat
          label={t('settlement.fxFeedRate')}
          value={fx?.feed_rate != null ? fmt(fx.feed_rate) : '—'}
          hint={
            fx?.fetched_at
              ? new Date(fx.fetched_at).toLocaleString('en-MY')
              : t('settlement.fxNotFetched')
          }
        />
        <Stat
          label={t('settlement.fxDepositRate', { unit })}
          value={fx?.quote ? `RM ${fmt(fx.quote.depositRate)}` : '—'}
          hint={t('settlement.fxDepositRateHint')}
        />
        <Stat
          label={t('settlement.fxPayoutRate', { unit })}
          value={fx?.quote ? `RM ${fmt(fx.quote.payoutRate)}` : '—'}
          hint={t('settlement.fxPayoutRateHint', { unit })}
        />
        <Stat
          label={t('settlement.fxEarned')}
          value={fx ? rm(fx.earnings.total_rm) : '—'}
          hint={
            fx
              ? t('settlement.fxEarnedHint', {
                  deposits: fx.earnings.deposits.count,
                  payouts: fx.earnings.payouts.count,
                })
              : ''
          }
        />
      </div>
      {fx?.quote_error && (
        <Text className="text-ui-fg-error border-t px-6 py-3" size="small">
          {t('settlement.fxQuoteError', { error: fx.quote_error, currency })}
        </Text>
      )}

      <div className="flex flex-wrap items-end gap-4 border-t px-6 py-4">
        <div className="flex flex-col gap-y-1">
          <Label htmlFor={id('markup')} size="small" weight="plus">
            {t('settlement.fxMarkup', { unit })}
          </Label>
          <Input
            id={id('markup')}
            className="w-32"
            inputMode="decimal"
            value={markup}
            onChange={(e) => setMarkup(e.target.value)}
            placeholder="0.05"
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch
            id={id('override')}
            checked={override}
            onCheckedChange={setOverride}
          />
          <Label htmlFor={id('override')} size="small">
            {t('settlement.fxManual')}
          </Label>
        </div>
        <div className="flex flex-col gap-y-1">
          <Label htmlFor={id('rate')} size="small" weight="plus">
            {t('settlement.fxManualRate')}
          </Label>
          <Input
            id={id('rate')}
            className="w-32"
            inputMode="decimal"
            value={manualRate}
            disabled={!override}
            onChange={(e) => setManualRate(e.target.value)}
            placeholder={fx?.feed_rate != null ? fmt(fx.feed_rate) : ''}
          />
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-y-1">
          <Label htmlFor={id('reason')} size="small" weight="plus">
            {t('settlement.fxReason')}
          </Label>
          <Input
            id={id('reason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('settlement.fxReasonPlaceholder')}
          />
        </div>
        <Button
          size="small"
          onClick={submit}
          isLoading={save.isPending}
          disabled={!canSave}
        >
          {t('settlement.fxSave')}
        </Button>
      </div>
      <Text
        className="text-ui-fg-subtle border-t px-6 py-3"
        size="small"
        data-testid={`fx-preview-${currency}`}
      >
        {depositRate !== null && payoutRate !== null
          ? t('settlement.fxPreview', {
              currency,
              credit: floorCents(100 * depositRate).toFixed(2),
              payout: floorCents(100 / payoutRate).toFixed(2),
              share: ((m / mid) * 100).toFixed(2),
            })
          : t('settlement.fxPreviewEmpty')}
      </Text>
    </Container>
  );
};

const Stat = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) => (
  <div className="flex flex-col gap-y-0.5">
    <Text size="xsmall" className="text-ui-fg-muted">
      {label}
    </Text>
    <Text size="large" weight="plus" className="tabular-nums">
      {value}
    </Text>
    <Text size="xsmall" className="text-ui-fg-subtle">
      {hint}
    </Text>
  </div>
);
