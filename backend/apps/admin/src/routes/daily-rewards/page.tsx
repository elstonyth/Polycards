import { useState } from 'react';
import {
  Container,
  Heading,
  Text,
  Button,
  Switch,
  Input,
  Label,
  toast,
} from '@medusajs/ui';
import { Calendar } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useDailyRewardSettings,
  useSaveDailyRewardSettings,
} from '../../lib/queries';
import type { DailyRewardSettingsDTO } from '../../lib/admin-rest';

export const config: RouteConfig = {
  label: 'Daily Rewards',
  icon: Calendar,
  nested: '/gacha',
  rank: 5,
};

const DAYS = [1, 2, 3, 4, 5, 6, 7];

// Storefront /daily check-in config: one MYR amount per streak day + a kill
// switch. Edits are audited server-side (reason mandatory) and take effect on
// the NEXT claim — already-claimed days never change.
const DailyRewardsPage = () => {
  const { data, isError } = useDailyRewardSettings();
  const save = useSaveDailyRewardSettings();

  // Seed the editable buffer from the server snapshot during render (same
  // pattern as the reward-pool editor) — reseeds after a post-save refetch.
  const [seededFrom, setSeededFrom] = useState<
    DailyRewardSettingsDTO | undefined
  >(undefined);
  const [enabled, setEnabled] = useState(true);
  const [amounts, setAmounts] = useState<string[]>(DAYS.map(() => '1'));
  const [reason, setReason] = useState('');
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setEnabled(data.enabled);
    setAmounts(data.amounts.map((n) => String(n)));
  }

  const parsed = amounts.map((a) => Number(a));
  const amountsValid = parsed.every((n) => Number.isFinite(n) && n > 0);
  const reasonValid = reason.trim().length > 0;
  // Never save the pre-fetch placeholder buffer over live config.
  const loaded = seededFrom !== undefined;

  const onSave = () => {
    if (!loaded) {
      toast.error('Settings are still loading — try again in a moment.');
      return;
    }
    if (!amountsValid) {
      toast.error('Every day needs a positive MYR amount.');
      return;
    }
    if (!reasonValid) {
      toast.error('A reason is required (it goes on the audit trail).');
      return;
    }
    save.mutate({ enabled, amounts: parsed, reason: reason.trim() });
  };

  return (
    <Container className="p-0">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <Heading level="h1">Daily Rewards</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            The storefront check-in calendar — credit paid per streak day (day 7
            wraps back to day 1).
          </Text>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="daily-enabled">Enabled</Label>
          <Switch
            id="daily-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
      </div>

      {isError && (
        <Text className="px-6 py-3 text-ui-fg-error" size="small">
          Couldn&apos;t load current settings — saving now would overwrite with
          what&apos;s shown here.
        </Text>
      )}

      <div className="grid grid-cols-2 gap-4 px-6 py-5 md:grid-cols-4">
        {DAYS.map((day, i) => (
          <div key={day}>
            <Label htmlFor={`daily-day-${day}`}>
              Day {day} (RM){day === 7 ? ' — streak finale' : ''}
            </Label>
            <Input
              id={`daily-day-${day}`}
              type="number"
              min="0.01"
              step="0.01"
              value={amounts[i]}
              onChange={(e) =>
                setAmounts((prev) =>
                  prev.map((v, j) => (j === i ? e.target.value : v)),
                )
              }
            />
          </div>
        ))}
      </div>

      <div className="flex items-end gap-3 border-t px-6 py-4">
        <div className="flex-1">
          <Label htmlFor="daily-reason">Reason (audit trail)</Label>
          <Input
            id="daily-reason"
            placeholder="e.g. July promo — richer day 7"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <Button onClick={onSave} isLoading={save.isPending} disabled={!loaded}>
          Save
        </Button>
      </div>
    </Container>
  );
};

export default DailyRewardsPage;
