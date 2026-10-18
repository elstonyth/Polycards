import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Heading, Input, Label, Select, Text } from '@medusajs/ui';
import type {
  AutomationConfig,
  AutomationRankTarget,
} from '../../../../../packages/api/src/api/utils/automation-types';
import { rm } from '../../lib/format';
import {
  DEFAULT_RANK_TARGET,
  profileCycleLimit,
  saveRankTarget,
} from './rank-target-draft';

type Props = {
  config: AutomationConfig;
  onChange: (config: AutomationConfig) => void;
  disabled: boolean;
  profiles: { id: string; name: string }[];
  selectedProfile: string;
};

export function RankTargetSettings({
  config,
  onChange,
  disabled,
  profiles,
  selectedProfile,
}: Props) {
  const { t } = useTranslation();
  const targets = config.rankTargets ?? [];
  const [draft, setDraft] = useState<AutomationRankTarget>({
    ...DEFAULT_RANK_TARGET,
    profileId: '',
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const profileId =
    draft.profileId ||
    (selectedProfile !== 'all'
      ? selectedProfile
      : profiles.find(
          (profile) =>
            !targets.some((target) => target.profileId === profile.id),
        )?.id) ||
    '';
  const accountName = profiles.find(
    (profile) => profile.id === profileId,
  )?.name;
  const set = <K extends keyof AutomationRankTarget>(
    key: K,
    value: AutomationRankTarget[K],
  ) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError('');
  };
  const reset = () => {
    setDraft({ ...DEFAULT_RANK_TARGET, profileId: '' });
    setEditingId(null);
    setError('');
  };
  const save = () => {
    try {
      const rankTargets = saveRankTarget(
        targets,
        { ...draft, profileId },
        editingId,
        profiles.map((profile) => profile.id),
      );
      onChange({ ...config, rankTargets });
      reset();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('automation.targets.invalid'),
      );
    }
  };
  const number = (
    key:
      | 'secureBufferMyr'
      | 'threatBufferMyr'
      | 'maxCycles'
      | 'maxSpendMyr'
      | 'maxDurationMinutes',
    min: number,
    max: number,
    step = '1',
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`target-${key}`}>{t(`automation.targets.${key}`)}</Label>
      <Input
        id={`target-${key}`}
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={Number.isFinite(draft[key]) ? draft[key] : ''}
        onChange={(event) =>
          set(
            key,
            event.target.value === '' ? Number.NaN : Number(event.target.value),
          )
        }
      />
    </div>
  );
  return (
    <section
      aria-labelledby="rank-targets-title"
      className="mt-6 border-t border-ui-border-base pt-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading id="rank-targets-title" level="h3">
          {t('automation.targets.title')}
        </Heading>
        <Text size="small" className="text-ui-fg-subtle">
          {t('automation.targets.count', { count: targets.length })}
        </Text>
      </div>
      <Text size="small" className="mt-1 max-w-3xl text-ui-fg-subtle">
        {t('automation.targets.description')}
      </Text>
      {targets.length > 0 && (
        <ul
          aria-label="Configured leaderboard targets"
          className="mt-4 max-h-72 overflow-y-auto divide-y divide-ui-border-base rounded-lg border border-ui-border-base"
        >
          {targets.map((target) => (
            <li
              key={target.profileId}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0 space-y-1">
                <Text size="small" className="break-words font-medium">
                  {profiles.find((profile) => profile.id === target.profileId)
                    ?.name ?? t('automation.targets.unavailableAccount')}
                </Text>
                <Text size="small" className="text-ui-fg-subtle">
                  {t(`automation.targets.goals.${target.goal}`, {
                    rank: target.targetRank,
                  })}{' '}
                  · {t(`automation.targets.periods.${target.period}`)} ·{' '}
                  {t(`automation.targets.modes.${target.mode}`)}
                </Text>
                {target.mode === 'test' && (
                  <Text size="small" className="text-ui-fg-subtle">
                    {t('automation.targets.limitsSummary', {
                      cycles: profileCycleLimit(config, target.profileId),
                      spend: rm(target.maxSpendMyr),
                      minutes: target.maxDurationMinutes,
                    })}
                  </Text>
                )}
                {selectedProfile !== 'all' &&
                  target.profileId !== selectedProfile && (
                    <Text size="small" className="text-ui-fg-subtle">
                      {t('automation.targets.excluded')}
                    </Text>
                  )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  disabled={disabled}
                  onClick={() => {
                    setDraft({ ...target });
                    setEditingId(target.profileId);
                    setError('');
                  }}
                >
                  {t('automation.targets.edit')}
                </Button>
                <Button
                  variant="transparent"
                  size="small"
                  disabled={disabled}
                  onClick={() => {
                    onChange({
                      ...config,
                      rankTargets: targets.filter(
                        (item) => item.profileId !== target.profileId,
                      ),
                    });
                    if (editingId === target.profileId) reset();
                  }}
                >
                  {t('automation.targets.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <details className="mt-4" open={editingId !== null ? true : undefined}>
        <summary className="cursor-pointer text-sm font-medium">
          {t(
            editingId
              ? 'automation.targets.editTarget'
              : 'automation.targets.addTarget',
          )}
        </summary>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="target-account">
              {t('automation.targets.account')}
            </Label>
            <Select
              value={profileId || undefined}
              onValueChange={(value) => set('profileId', value)}
              disabled={disabled || profiles.length === 0}
            >
              <Select.Trigger id="target-account">
                <Select.Value
                  placeholder={t('automation.targets.chooseAccount')}
                />
              </Select.Trigger>
              <Select.Content>
                {profiles.map((profile) => (
                  <Select.Item
                    value={profile.id}
                    key={profile.id}
                    disabled={targets.some(
                      (target) =>
                        target.profileId === profile.id &&
                        target.profileId !== editingId,
                    )}
                  >
                    {profile.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="target-period">
              {t('automation.targets.board')}
            </Label>
            <Select
              value={draft.period}
              onValueChange={(value) =>
                set('period', value as AutomationRankTarget['period'])
              }
              disabled={disabled}
            >
              <Select.Trigger id="target-period">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {(['weekly', 'alltime'] as const).map((period) => (
                  <Select.Item key={period} value={period}>
                    {t(`automation.targets.periods.${period}`)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="target-preset">{t('automation.targets.aim')}</Label>
            <Select
              value={`${draft.goal}-${draft.targetRank}`}
              onValueChange={(value) => {
                const [goal, rank] = value.split('-');
                setDraft((previous) => ({
                  ...previous,
                  goal: goal as AutomationRankTarget['goal'],
                  targetRank: Number(rank),
                }));
                setError('');
              }}
              disabled={disabled}
            >
              <Select.Trigger id="target-preset">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {(['reach', 'maintain'] as const).flatMap((goal) =>
                  Array.from({ length: 10 }, (_, index) => index + 1).map(
                    (rank) => (
                      <Select.Item
                        key={`${goal}-${rank}`}
                        value={`${goal}-${rank}`}
                      >
                        {t(`automation.targets.goals.${goal}`, { rank })}
                      </Select.Item>
                    ),
                  ),
                )}
              </Select.Content>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="target-mode">{t('automation.targets.mode')}</Label>
            <Select
              value={draft.mode}
              onValueChange={(value) =>
                set('mode', value as AutomationRankTarget['mode'])
              }
              disabled={disabled}
            >
              <Select.Trigger id="target-mode">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {(['shadow', 'monitor', 'test'] as const).map((mode) => (
                  <Select.Item key={mode} value={mode}>
                    {t(`automation.targets.modes.${mode}`)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
        </div>
        <Text size="small" className="mt-3 text-ui-fg-subtle">
          {t(`automation.targets.modeNotes.${draft.mode}`)}
        </Text>
        <details className="mt-4 rounded-lg bg-ui-bg-subtle px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t('automation.targets.advanced')}
          </summary>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {number('secureBufferMyr', 0, 1_000_000, '0.01')}
            {number('threatBufferMyr', 0, 1_000_000, '0.01')}
            {number('maxCycles', 1, 10)}
            {number('maxSpendMyr', 10, 100, '0.01')}
            {number('maxDurationMinutes', 1, 60)}
          </div>
          <Text size="small" className="mt-3 text-ui-fg-subtle">
            {t('automation.targets.buffersNote')}
          </Text>
          <Text size="small" className="mt-2 text-ui-fg-subtle">
            {t('automation.targets.limitNote', {
              cycles: config.maxCyclesPerProfile,
            })}
          </Text>
        </details>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ui-border-base px-4 py-3">
          <Text size="small" className="min-w-0 break-words">
            {accountName
              ? t('automation.targets.summary', {
                  account: accountName,
                  goal: t(`automation.targets.goals.${draft.goal}`, {
                    rank: draft.targetRank,
                  }),
                  period: t(`automation.targets.periods.${draft.period}`),
                  mode: t(`automation.targets.modes.${draft.mode}`),
                })
              : t('automation.targets.chooseAccount')}
          </Text>
          <div className="flex shrink-0 gap-2">
            {editingId && (
              <Button variant="transparent" disabled={disabled} onClick={reset}>
                {t('automation.targets.cancel')}
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={disabled || !profileId}
              onClick={save}
            >
              {t(
                editingId
                  ? 'automation.targets.save'
                  : 'automation.targets.add',
              )}
            </Button>
          </div>
        </div>
        {error && (
          <Text size="small" role="alert" className="mt-3 text-ui-fg-error">
            {error}
          </Text>
        )}
      </details>
      <Text size="small" className="mt-4 text-ui-fg-subtle">
        {t('automation.targets.scopeNote')}
      </Text>
    </section>
  );
}
