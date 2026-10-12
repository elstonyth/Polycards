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
// fee on it, a percent of the market rate each way behind an on/off switch.
// Customers pay and are paid in that currency; the ledger stays in RM. A
// top-up credits at market x (1 - top-up fee), a payout costs market x
// (1 + withdrawal fee); the difference is what the conversion earns. Fee off
// = both at the market rate. Every payment locks the rate it was quoted at,
// so a change here only affects payments started AFTER it is saved.

const fmt = (n: number, dp = 4) => n.toFixed(dp);
const floorCents = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
// Mirrors payment-fx.ts round6, so the preview shows the rate a save quotes.
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

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
  const [feeOn, setFeeOn] = useState(true);
  const [depositFee, setDepositFee] = useState('');
  const [payoutFee, setPayoutFee] = useState('');
  const [override, setOverride] = useState(false);
  const [manualRate, setManualRate] = useState('');
  const [reason, setReason] = useState('');
  if (fx && !seeded) {
    setSeeded(true);
    // Never configured (null): start with the fee on, percentages to fill in.
    const configured = fx.fee_enabled != null;
    setFeeOn(fx.fee_enabled ?? true);
    setDepositFee(configured ? String(fx.deposit_fee_percent) : '');
    setPayoutFee(configured ? String(fx.payout_fee_percent) : '');
    setOverride(fx.manual_override);
    setManualRate(fx.manual_rate != null ? String(fx.manual_rate) : '');
  }

  // Live preview of what a customer gets with the values as typed. The band
  // is the backend's (PAYMENT_FX_FEEDS), so the preview and the save agree.
  const unit = fx?.unit ?? `1 ${currency}`;
  const max = fx?.max_fee_percent ?? 20;
  const mid = override ? Number(manualRate) : (fx?.feed_rate ?? NaN);
  const midOk =
    Number.isFinite(mid) &&
    mid > 0 &&
    (!override ||
      ((fx?.manual_band.min == null || mid >= fx.manual_band.min) &&
        (fx?.manual_band.max == null || mid <= fx.manual_band.max)));
  // The percentages are saved even while the fee is off, so switching it
  // back on restores them; both must be valid either way.
  const pct = (raw: string) => {
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= max
      ? n
      : null;
  };
  const inPct = pct(depositFee);
  const outPct = pct(payoutFee);
  const depositRate =
    midOk && inPct !== null && outPct !== null
      ? round6(mid * (1 - (feeOn ? inPct : 0) / 100))
      : null;
  const payoutRate =
    midOk && inPct !== null && outPct !== null
      ? round6(mid * (1 + (feeOn ? outPct : 0) / 100))
      : null;
  const canSave =
    !save.isPending &&
    depositRate !== null &&
    payoutRate !== null &&
    reason.trim().length > 0;

  const submit = async () => {
    if (!canSave || inPct === null || outPct === null) return;
    const confirmed = await prompt({
      title: t('settlement.fxConfirmTitle', { currency }),
      description: t(
        feeOn ? 'settlement.fxConfirm' : 'settlement.fxConfirmOff',
        {
          currency,
          unit,
          deposit: fmt(depositRate as number),
          payout: fmt(payoutRate as number),
        },
      ),
      confirmText: t('settlement.fxSave'),
      variant: 'confirmation',
    });
    if (!confirmed) return;
    save.mutate(
      {
        currency,
        fee_enabled: feeOn,
        deposit_fee_percent: inPct,
        payout_fee_percent: outPct,
        manual_override: override,
        manual_rate: override ? Number(manualRate) : null,
        reason: reason.trim(),
      },
      { onSuccess: () => setReason('') },
    );
  };

  const id = (field: string) => `fx-${currency.toLowerCase()}-${field}`;
  const q = fx?.quote;
  return (
    <Container className="p-0" data-testid={`fx-card-${currency}`}>
      <div className="flex items-start justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">{t('settlement.fxTitle', { currency })}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('settlement.fxSubtitle', { currency, unit })}
          </Text>
        </div>
        {q ? (
          <Badge color="green" size="small">
            {q.feeEnabled
              ? t('settlement.fxQuoting')
              : t('settlement.fxQuotingNoFee')}
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
          label={t('settlement.fxDepositRate', { unit })}
          value={q ? `RM ${fmt(q.depositRate)}` : '—'}
          hint={
            q
              ? t('settlement.fxDepositRateHint', { pct: q.depositFeePercent })
              : ''
          }
        />
        <Stat
          label={t('settlement.fxPayoutRate', { unit })}
          value={q ? `RM ${fmt(q.payoutRate)}` : '—'}
          hint={
            q
              ? t('settlement.fxPayoutRateHint', { pct: q.payoutFeePercent })
              : ''
          }
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
        <div className="flex items-center gap-2 pb-2">
          <Switch id={id('fee')} checked={feeOn} onCheckedChange={setFeeOn} />
          <Label htmlFor={id('fee')} size="small" weight="plus">
            {t('settlement.fxFeeOn')}
          </Label>
        </div>
        <div className="flex flex-col gap-y-1">
          <Label htmlFor={id('deposit-fee')} size="small" weight="plus">
            {t('settlement.fxDepositFee')}
          </Label>
          <Input
            id={id('deposit-fee')}
            className="w-28"
            inputMode="decimal"
            value={depositFee}
            disabled={!feeOn}
            onChange={(e) => setDepositFee(e.target.value)}
            placeholder="0.5"
          />
        </div>
        <div className="flex flex-col gap-y-1">
          <Label htmlFor={id('payout-fee')} size="small" weight="plus">
            {t('settlement.fxPayoutFee')}
          </Label>
          <Input
            id={id('payout-fee')}
            className="w-28"
            inputMode="decimal"
            value={payoutFee}
            disabled={!feeOn}
            onChange={(e) => setPayoutFee(e.target.value)}
            placeholder="0.5"
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
            className="w-28"
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
          ? t(feeOn ? 'settlement.fxPreview' : 'settlement.fxPreviewOff', {
              currency,
              mid: fmt(mid),
              deposit: fmt(depositRate),
              payout: fmt(payoutRate),
              inPct,
              outPct,
              credit: floorCents(100 * depositRate).toFixed(2),
              paid: floorCents(100 / payoutRate).toFixed(2),
            })
          : t('settlement.fxPreviewEmpty', { max })}
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
