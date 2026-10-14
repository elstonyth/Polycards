import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Drawer,
  Input,
  Label,
  Switch,
  Text,
  toast,
  usePrompt,
} from '@medusajs/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setPaymentFx, type PaymentFxState } from '../../lib/admin-rest';
import { floorCents, fmtRate, fxKey, round6, usePaymentFx } from './fx-shared';

/** "Edit rates" — the regional rail's fee and market-rate form in a side
 *  panel. The form mounts when the panel opens, so it always starts from the
 *  saved values. */
export const FxEditDrawer = ({
  currency,
  open,
  onOpenChange,
}: {
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useTranslation();
  const { data: fx } = usePaymentFx(currency);
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>
            {t('settlement.fxEditTitle', { currency })}
          </Drawer.Title>
        </Drawer.Header>
        {fx ? (
          <FxForm
            currency={currency}
            fx={fx}
            onSaved={() => onOpenChange(false)}
          />
        ) : null}
      </Drawer.Content>
    </Drawer>
  );
};

const FxForm = ({
  currency,
  fx,
  onSaved,
}: {
  currency: string;
  fx: PaymentFxState;
  onSaved: () => void;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const prompt = usePrompt();
  const save = useMutation({
    mutationFn: setPaymentFx,
    onSuccess: (next) => {
      qc.setQueryData(fxKey(currency), next);
      toast.success(t('settlement.fxSaved', { currency }));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  // Never configured (fee_enabled null): start with the fee on, percentages
  // to fill in.
  const configured = fx.fee_enabled != null;
  const [feeOn, setFeeOn] = useState(fx.fee_enabled ?? true);
  const [depositFee, setDepositFee] = useState(
    configured ? String(fx.deposit_fee_percent) : '',
  );
  const [payoutFee, setPayoutFee] = useState(
    configured ? String(fx.payout_fee_percent) : '',
  );
  const [override, setOverride] = useState(fx.manual_override);
  const [manualRate, setManualRate] = useState(
    fx.manual_rate != null ? String(fx.manual_rate) : '',
  );
  const [reason, setReason] = useState('');

  // Live preview of what a customer gets with the values as typed. The band
  // is the backend's (PAYMENT_FX_FEEDS), so the preview and the save agree.
  const unit = fx.unit ?? `1 ${currency}`;
  const max = fx.max_fee_percent ?? 20;
  const mid = override ? Number(manualRate) : (fx.feed_rate ?? NaN);
  const midOk =
    Number.isFinite(mid) &&
    mid > 0 &&
    (!override ||
      ((fx.manual_band.min == null || mid >= fx.manual_band.min) &&
        (fx.manual_band.max == null || mid <= fx.manual_band.max)));
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
          deposit: fmtRate(depositRate as number),
          payout: fmtRate(payoutRate as number),
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
      { onSuccess: onSaved },
    );
  };

  const id = (field: string) => `fx-${currency.toLowerCase()}-${field}`;
  return (
    <>
      <Drawer.Body className="flex flex-col gap-5 overflow-y-auto">
        <div className="flex items-center gap-2">
          <Switch id={id('fee')} checked={feeOn} onCheckedChange={setFeeOn} />
          <Label htmlFor={id('fee')} size="small" weight="plus">
            {t('settlement.fxFeeOn')}
          </Label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-y-1">
            <Label htmlFor={id('deposit-fee')} size="small" weight="plus">
              {t('settlement.fxDepositFee')}
            </Label>
            <Input
              id={id('deposit-fee')}
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
              inputMode="decimal"
              value={payoutFee}
              disabled={!feeOn}
              onChange={(e) => setPayoutFee(e.target.value)}
              placeholder="0.5"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
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
            inputMode="decimal"
            value={manualRate}
            disabled={!override}
            onChange={(e) => setManualRate(e.target.value)}
            placeholder={fx.feed_rate != null ? fmtRate(fx.feed_rate) : ''}
          />
        </div>
        <Text
          size="small"
          className="bg-ui-bg-subtle text-ui-fg-subtle rounded-lg border px-3 py-2"
          data-testid={`fx-preview-${currency}`}
        >
          {depositRate !== null && payoutRate !== null
            ? t(feeOn ? 'settlement.fxPreview' : 'settlement.fxPreviewOff', {
                currency,
                mid: fmtRate(mid),
                deposit: fmtRate(depositRate),
                payout: fmtRate(payoutRate),
                inPct,
                outPct,
                credit: floorCents(100 * depositRate).toFixed(2),
                paid: floorCents(100 / payoutRate).toFixed(2),
              })
            : t('settlement.fxPreviewEmpty', { max })}
        </Text>
        <div className="flex flex-col gap-y-1">
          <Label htmlFor={id('reason')} size="small" weight="plus">
            {t('settlement.fxReason')}
          </Label>
          <Input
            id={id('reason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('settlement.fxReasonPlaceholder')}
          />
          <Text size="xsmall" className="text-ui-fg-muted">
            {t('settlement.fxAppliesNext')}
          </Text>
        </div>
      </Drawer.Body>
      <Drawer.Footer>
        <Drawer.Close asChild>
          <Button size="small" variant="secondary">
            {t('settlement.cancel')}
          </Button>
        </Drawer.Close>
        <Button
          size="small"
          onClick={submit}
          isLoading={save.isPending}
          disabled={!canSave}
        >
          {t('settlement.fxSave')}
        </Button>
      </Drawer.Footer>
    </>
  );
};
