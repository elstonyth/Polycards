import { useState } from 'react';
import { Button, Heading, Input, Label, Select, Text } from '@medusajs/ui';
import type {
  LiveConfig,
  LiveSnapshot,
} from '../../../../../packages/api/src/api/utils/automation-live-types';
import { validateLiveRankTargets } from '../../../../../packages/api/src/api/utils/automation-live-rank';
import { orderDateTime, rm } from '../../lib/format';

export function LiveRankSettings({
  config,
  state,
  disabled,
  onChange,
}: {
  config: LiveConfig;
  state: LiveSnapshot | undefined;
  disabled: boolean;
  onChange(config: LiveConfig): void;
}) {
  const [customerId, setCustomerId] = useState('');
  const period = 'alltime';
  const [targetRank, setTargetRank] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const targets = config.rankTargets ?? [];
  const names = new Map(
    state?.accounts.map((account) => [account.id, account.name]),
  );
  const add = () => {
    try {
      const rankTargets = validateLiveRankTargets(
        [...targets, { customerId, period, targetRank }],
        config.customerIds,
      );
      onChange({ ...config, rankTargets });
      setCustomerId('');
      setError(null);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Invalid live rank goal.',
      );
    }
  };
  return (
    <div className="mt-5 space-y-3 border-t pt-5">
      <Heading level="h3">Live leaderboard rank goals</Heading>
      <Text size="small" className="text-ui-fg-subtle">
        Optional. A goal account draws whenever a fresh rank check allows it,
        past the packs-per-account limit (up to 100 a round), and pushes past
        our own accounts too; the other selected accounts keep their ordinary
        draws in between. A goal stops after two fresh checks confirm its Top N
        rank. Humanized timing still applies. Rankings can change
        afterward. Goals use the all-time board only: Automation accounts never
        rank on the weekly challenge board or receive its prizes.
      </Text>
      {disabled && (
        <Text size="small">
          Goal settings unlock after the current run ends. Its saved settings
          remain active.
        </Text>
      )}
      <fieldset
        disabled={disabled}
        className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <div className="space-y-2">
          <Label htmlFor="live-rank-account">Goal account</Label>
          <Select
            value={customerId || undefined}
            disabled={disabled}
            onValueChange={setCustomerId}
          >
            <Select.Trigger id="live-rank-account">
              <Select.Value placeholder="Choose selected account" />
            </Select.Trigger>
            <Select.Content>
              {state?.accounts
                .filter(
                  (account) =>
                    config.customerIds.includes(account.id) &&
                    !targets.some((target) => target.customerId === account.id),
                )
                .map((account) => (
                  <Select.Item value={account.id} key={account.id}>
                    {account.name}
                  </Select.Item>
                ))}
            </Select.Content>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="live-rank-position">Reach Top N</Label>
          <Input
            id="live-rank-position"
            type="number"
            min={1}
            max={10}
            value={targetRank}
            onChange={(event) => setTargetRank(Number(event.target.value))}
          />
        </div>
        <Button
          variant="secondary"
          disabled={disabled || !customerId}
          onClick={add}
        >
          Add live rank goal
        </Button>
      </fieldset>
      {error && (
        <Text role="alert" className="text-ui-fg-error">
          {error}
        </Text>
      )}
      {!targets.length && (
        <Text size="small">
          No rank goals configured. Selected accounts follow the ordinary cycle
          run.
        </Text>
      )}
      {targets.map((target) => {
        const goal = state?.rankGoals?.find(
          (row) =>
            row.target.profileId === target.customerId &&
            row.target.period === target.period &&
            row.target.targetRank === target.targetRank,
        );
        return (
          <div
            key={target.customerId}
            className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
          >
            <div className="min-w-0 space-y-1">
              <Text weight="plus">
                {names.get(target.customerId) ?? target.customerId} ·{' '}
                {target.period === 'weekly' ? 'Weekly' : 'All time'} · Reach Top{' '}
                {target.targetRank}
              </Text>
              <Text size="small">
                {goal
                  ? `Current rank: ${goal.status.currentRank === null ? 'Outside visible Top 10' : `#${goal.status.currentRank}`} · ${goal.status.state}`
                  : 'Waiting for this goal’s run to start.'}
              </Text>
              {goal && <Text size="small">{goal.status.reason}</Text>}
              {goal?.status.gapMyr !== null &&
                goal?.status.gapMyr !== undefined && (
                  <Text size="small" className="text-ui-fg-subtle">
                    Pulled-value gap: {rm(goal.status.gapMyr)}. Draw outcomes
                    cannot guarantee a rank.
                  </Text>
                )}
              {goal?.status.observedAt && (
                <Text size="small" className="text-ui-fg-subtle">
                  Last observation:{' '}
                  <time dateTime={goal.status.observedAt}>
                    {orderDateTime(goal.status.observedAt)}
                  </time>
                </Text>
              )}
            </div>
            <Button
              variant="transparent"
              size="small"
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...config,
                  rankTargets: targets.filter(
                    (row) => row.customerId !== target.customerId,
                  ),
                })
              }
            >
              Remove goal
            </Button>
          </div>
        );
      })}
    </div>
  );
}
