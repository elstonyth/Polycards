import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  Text,
} from '@medusajs/ui';
import type { AutomationConfig } from '../../../../../packages/api/src/api/utils/automation-types';
import { DEFAULT_AUTOMATION_CONFIG } from '../../../../../packages/api/src/api/utils/automation-config';
import { importAutomationSettings } from './settings-import';
import { RankTargetSettings } from './rank-target-settings';

export const DEFAULT_CONFIG = DEFAULT_AUTOMATION_CONFIG;

type Props = {
  config: AutomationConfig;
  onChange: (config: AutomationConfig) => void;
  disabled: boolean;
  profiles: { id: string; name: string }[];
  selectedProfile: string;
  onSelectProfile: (id: string) => void;
};

export function RunSettings({
  config,
  onChange,
  disabled,
  profiles,
  selectedProfile,
  onSelectProfile,
}: Props) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importNote, setImportNote] = useState('');
  const [importError, setImportError] = useState('');
  const update = <K extends keyof AutomationConfig>(
    key: K,
    value: AutomationConfig[K],
  ) => onChange({ ...config, [key]: value });
  const numeric = (
    key:
      | 'fixedIntervalSeconds'
      | 'randomMinSeconds'
      | 'randomMaxSeconds'
      | 'maxCyclesPerProfile'
      | 'maxTotalSpend',
    label: string,
    min: number,
    max: number,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`automation-${key}`}>{label}</Label>
      <Input
        id={`automation-${key}`}
        type="number"
        min={min}
        max={max}
        step={key === 'maxTotalSpend' ? '0.01' : '1'}
        value={Number.isFinite(config[key]) ? config[key] : ''}
        disabled={disabled}
        onChange={(event) =>
          update(
            key,
            event.target.value === '' ? Number.NaN : Number(event.target.value),
          )
        }
      />
    </div>
  );
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportNote('');
    setImportError('');
    try {
      if (file.size > 65_536)
        throw new Error(t('automation.settings.fileTooLarge'));
      const imported = importAutomationSettings(await file.text(), config);
      onChange(imported.config);
      setImportNote(imported.notes.join(' '));
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : t('automation.settings.importError'),
      );
    }
  };
  return (
    <Container className="mb-4 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading level="h2">{t('automation.settings.title')}</Heading>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => fileInput.current?.click()}
        >
          {t('automation.settings.import')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          disabled={disabled}
          onChange={(event) => void importFile(event)}
          aria-label={t('automation.settings.import')}
        />
      </div>
      <Text size="small" className="mt-4 font-medium">
        {t('automation.settings.accountsAndTiming')}
      </Text>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="automation-profiles">
            {t('automation.settings.profiles')}
          </Label>
          <Select
            value={selectedProfile}
            onValueChange={onSelectProfile}
            disabled={disabled}
          >
            <Select.Trigger id="automation-profiles">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="all">
                {t('automation.settings.allProfiles', {
                  count: profiles.length,
                })}
              </Select.Item>
              {profiles.map((profile) => (
                <Select.Item value={profile.id} key={profile.id}>
                  {profile.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="automation-timing">
            {t('automation.settings.timing')}
          </Label>
          <Select
            value={config.timingMode}
            onValueChange={(value) =>
              onChange({
                ...config,
                timingMode: value as AutomationConfig['timingMode'],
                humanizedTestClock: false,
              })
            }
            disabled={disabled}
          >
            <Select.Trigger id="automation-timing">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="fixed">
                {t('automation.settings.fixed')}
              </Select.Item>
              <Select.Item value="random">
                {t('automation.settings.random')}
              </Select.Item>
              <Select.Item value="humanized">
                {t('automation.settings.humanized')}
              </Select.Item>
            </Select.Content>
          </Select>
        </div>
        {config.timingMode === 'fixed' &&
          numeric(
            'fixedIntervalSeconds',
            t('automation.settings.interval'),
            2,
            86400,
          )}
        {config.timingMode === 'random' && (
          <>
            {numeric(
              'randomMinSeconds',
              t('automation.settings.minimum'),
              2,
              86400,
            )}
            {numeric(
              'randomMaxSeconds',
              t('automation.settings.maximum'),
              2,
              86400,
            )}
          </>
        )}
        {config.timingMode === 'humanized' && (
          <div className="space-y-2">
            <Label htmlFor="automation-region">
              {t('automation.settings.region')}
            </Label>
            <Select
              value={config.humanizedRegion}
              onValueChange={(value) =>
                update(
                  'humanizedRegion',
                  value as AutomationConfig['humanizedRegion'],
                )
              }
              disabled={disabled}
            >
              <Select.Trigger id="automation-region">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="mysg">Malaysia / Singapore</Select.Item>
                <Select.Item value="global">
                  {t('automation.settings.global')}
                </Select.Item>
              </Select.Content>
            </Select>
          </div>
        )}
      </div>
      <Text size="small" className="mt-4 text-ui-fg-subtle">
        {t(
          config.timingMode === 'humanized'
            ? 'automation.settings.humanizedNote'
            : 'automation.settings.timingNote',
        )}
      </Text>
      {config.timingMode === 'humanized' && (
        <div className="mt-4 space-y-2">
          <Label htmlFor="automation-test-clock">
            {t('automation.settings.clock')}
          </Label>
          <Select
            value={config.humanizedTestClock ? 'accelerated' : 'normal'}
            disabled={disabled}
            onValueChange={(value) =>
              update('humanizedTestClock', value === 'accelerated')
            }
          >
            <Select.Trigger id="automation-test-clock">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="normal">
                {t('automation.settings.normalClock')}
              </Select.Item>
              <Select.Item value="accelerated">
                {t('automation.settings.testClock')}
              </Select.Item>
            </Select.Content>
          </Select>
          {config.humanizedTestClock && (
            <Text size="small" className="text-ui-fg-subtle">
              {t('automation.settings.testClockNote')}
            </Text>
          )}
        </div>
      )}
      <div className="mt-5 border-t border-ui-border-base pt-4">
        <Text size="small" className="font-medium">
          {t('automation.settings.limits')}
        </Text>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:max-w-2xl">
          {numeric(
            'maxCyclesPerProfile',
            t('automation.settings.cycles'),
            1,
            10,
          )}
          {numeric(
            'maxTotalSpend',
            t('automation.settings.spendLimit'),
            10,
            8000,
          )}
        </div>
      </div>
      <RankTargetSettings
        config={config}
        onChange={onChange}
        disabled={disabled}
        profiles={profiles}
        selectedProfile={selectedProfile}
      />
      {importNote && (
        <Text size="small" role="status" className="mt-3 text-ui-fg-subtle">
          {importNote}
        </Text>
      )}
      {importError && (
        <Text size="small" role="alert" className="mt-3 text-ui-fg-error">
          {importError}
        </Text>
      )}
    </Container>
  );
}
