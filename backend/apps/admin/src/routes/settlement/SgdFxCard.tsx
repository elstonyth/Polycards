import { useState } from 'react';
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

// Singapore (A3Pay) conversion: the SGD->RM market rate and OUR markup on it.
// Customers pay and are paid in S$; the ledger stays in RM. A top-up credits
// at market - markup, a payout pays at market + markup, and the difference is
// what the conversion earns. Every SGD payment locks the rate it was quoted
// at, so a change here only affects payments started AFTER it is saved.
const KEY = ['payment-fx', 'SGD'] as const;

const fmt = (n: number, dp = 4) => n.toFixed(dp);
const floorCents = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

export const SgdFxCard = () => {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const { data: fx, isError } = useQuery({
    queryKey: KEY,
    queryFn: getPaymentFx,
  });
  const save = useMutation({
    mutationFn: setPaymentFx,
    onSuccess: (next) => {
      qc.setQueryData(KEY, next);
      toast.success('SGD conversion updated');
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

  // Live preview of what a customer gets with the values as typed.
  const mid = override ? Number(manualRate) : (fx?.feed_rate ?? NaN);
  const m = Number(markup);
  const midOk = Number.isFinite(mid) && mid >= 1 && mid <= 10;
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
      title: 'Save SGD conversion',
      description: `New Singapore top-ups will credit RM ${fmt(depositRate)} per S$1 and payouts will cost RM ${fmt(payoutRate)} per S$1. Payments already started keep their rate. Continue?`,
      confirmText: 'Save',
      variant: 'confirmation',
    });
    if (!confirmed) return;
    save.mutate(
      {
        markup: m,
        manual_override: override,
        manual_rate: override ? Number(manualRate) : null,
        reason: reason.trim(),
      },
      { onSuccess: () => setReason('') },
    );
  };

  return (
    <Container className="p-0" data-testid="sgd-fx-card">
      <div className="flex items-start justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">Singapore — SGD conversion (A3Pay)</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            Customers pay and are paid in S$; credits stay in RM. The markup is
            in RM per S$1 and is taken on both sides.
          </Text>
        </div>
        {fx?.quote ? (
          <Badge color="green" size="small">
            Quoting
          </Badge>
        ) : (
          <Badge color="red" size="small">
            {isError ? 'Unavailable' : 'Paused'}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 border-t px-6 py-4 md:grid-cols-4">
        <Stat
          label="Market rate (feed)"
          value={fx?.feed_rate != null ? fmt(fx.feed_rate) : '—'}
          hint={
            fx?.fetched_at
              ? new Date(fx.fetched_at).toLocaleString('en-MY')
              : 'not fetched yet'
          }
        />
        <Stat
          label="Top-up rate (S$1 →)"
          value={fx?.quote ? `RM ${fmt(fx.quote.depositRate)}` : '—'}
          hint="what a customer is credited"
        />
        <Stat
          label="Payout rate (→ S$1)"
          value={fx?.quote ? `RM ${fmt(fx.quote.payoutRate)}` : '—'}
          hint="what each S$1 paid out costs"
        />
        <Stat
          label="Conversion earned"
          value={fx ? rm(fx.earnings.total_rm) : '—'}
          hint={
            fx
              ? `${fx.earnings.deposits.count} top-ups · ${fx.earnings.payouts.count} payouts settled`
              : ''
          }
        />
      </div>
      {fx?.quote_error && (
        <Text className="text-ui-fg-error border-t px-6 py-3" size="small">
          {fx.quote_error} SGD top-ups and payouts are refused until this is
          fixed.
        </Text>
      )}

      <div className="flex flex-wrap items-end gap-4 border-t px-6 py-4">
        <div className="flex flex-col gap-y-1">
          <Label htmlFor="sgd-markup" size="small" weight="plus">
            Markup (RM per S$1)
          </Label>
          <Input
            id="sgd-markup"
            className="w-32"
            inputMode="decimal"
            value={markup}
            onChange={(e) => setMarkup(e.target.value)}
            placeholder="0.05"
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch
            id="sgd-override"
            checked={override}
            onCheckedChange={setOverride}
          />
          <Label htmlFor="sgd-override" size="small">
            Manual market rate
          </Label>
        </div>
        <div className="flex flex-col gap-y-1">
          <Label htmlFor="sgd-rate" size="small" weight="plus">
            Market rate
          </Label>
          <Input
            id="sgd-rate"
            className="w-32"
            inputMode="decimal"
            value={manualRate}
            disabled={!override}
            onChange={(e) => setManualRate(e.target.value)}
            placeholder={fx?.feed_rate != null ? fmt(fx.feed_rate) : '3.20'}
          />
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-y-1">
          <Label htmlFor="sgd-reason" size="small" weight="plus">
            Reason
          </Label>
          <Input
            id="sgd-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required — why is this changing?"
          />
        </div>
        <Button
          size="small"
          onClick={submit}
          isLoading={save.isPending}
          disabled={!canSave}
        >
          Save
        </Button>
      </div>
      <Text
        className="text-ui-fg-subtle border-t px-6 py-3"
        size="small"
        data-testid="sgd-fx-preview"
      >
        {depositRate !== null && payoutRate !== null
          ? `Preview: S$100 top-up → RM ${floorCents(100 * depositRate).toFixed(2)} credit · RM 100 payout → S$${floorCents(100 / payoutRate).toFixed(2)} to the bank (${((m / mid) * 100).toFixed(2)}% each way)`
          : 'Enter a markup between 0 and 20% of the market rate to see the customer rates.'}
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
