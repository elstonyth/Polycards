import { useState } from 'react';
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Switch,
  Text,
  usePrompt,
} from '@medusajs/ui';
import { useFxHistory, useFxRate, useSetFxRate } from '../../lib/queries';

// Pricing control: the USD→MYR exchange rate the storefront reprices against.
// The ONLY UI that writes /admin/pricing/fx (via useSetFxRate). Saving reprices
// every card immediately, so it lives here on the Storefront/Pricing page — not
// the read-only Economy report. Behavior is unchanged from its former home.
export const FxCard = () => {
  const { data: fx } = useFxRate();
  const { data: history } = useFxHistory();
  const setFx = useSetFxRate();
  const prompt = usePrompt();
  const [override, setOverride] = useState(false);
  const [rate, setRate] = useState('');
  const [reason, setReason] = useState('');
  const [seeded, setSeeded] = useState(false);
  if (fx && !seeded) {
    setSeeded(true);
    setOverride(fx.manual_override);
    setRate(fx.manual_rate != null ? String(fx.manual_rate) : '');
  }

  const rateNum = Number(rate);
  const rateValid =
    !override || (Number.isFinite(rateNum) && rateNum > 0 && rateNum <= 1000);
  const canSave = !setFx.isPending && rateValid && reason.trim().length > 0;

  const save = async () => {
    if (!canSave) return;
    const confirmed = await prompt({
      title: 'Save exchange rate',
      description:
        'This reprices every card on the storefront immediately. Continue?',
      confirmText: 'Save rate',
      variant: 'confirmation',
    });
    if (!confirmed) return;
    setFx.mutate({
      manual_override: override,
      manual_rate: override ? rateNum : null,
      reason: reason.trim(),
    });
    setReason('');
  };

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Pricing — exchange rate (USD → MYR)</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          Effective rate: {fx ? fx.effective.toFixed(4) : '…'}
          {fx?.manual_override ? ' (manual override)' : ' (auto)'}
        </Text>
      </div>
      <div className="flex flex-wrap items-end gap-4 border-t px-6 py-4">
        <div className="flex items-center gap-2">
          <Switch checked={override} onCheckedChange={setOverride} id="fx-ovr" />
          <Label htmlFor="fx-ovr" size="small">
            Manual override
          </Label>
        </div>
        <div className="flex flex-col gap-y-1">
          <Label htmlFor="fx-rate" size="small" weight="plus">
            Rate
          </Label>
          <Input
            id="fx-rate"
            className="w-32"
            value={rate}
            disabled={!override}
            onChange={(e) => setRate(e.target.value)}
            placeholder="4.70"
          />
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-y-1">
          <Label htmlFor="fx-reason" size="small" weight="plus">
            Reason
          </Label>
          <Input
            id="fx-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required — why is the rate changing?"
          />
        </div>
        <Button
          size="small"
          onClick={save}
          isLoading={setFx.isPending}
          disabled={!canSave}
        >
          Save rate
        </Button>
      </div>
      {history && history.changes.length > 0 && (
        <div className="border-t px-6 py-4">
          <Text size="small" weight="plus">
            Recent changes
          </Text>
          <ul className="mt-2 flex flex-col gap-1">
            {history.changes.map((c, i) => (
              <li key={i} className="text-ui-fg-subtle text-sm">
                {new Date(c.at).toLocaleString('en-US')} — {c.admin_id}:{' '}
                {c.after.manual_override
                  ? `override → ${c.after.manual_rate}`
                  : 'override off'}
                {c.reason ? ` (${c.reason})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Container>
  );
};
