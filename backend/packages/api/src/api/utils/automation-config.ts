import type { AutomationConfig } from './automation-types';
import { validateRankTargets } from './automation-rank';

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  timingMode: 'fixed',
  fixedIntervalSeconds: 2,
  randomMinSeconds: 2,
  randomMaxSeconds: 5,
  maxCyclesPerProfile: 1,
  maxTotalSpend: 8000,
  humanizedRegion: 'mysg',
  humanizedTestClock: false,
  rankTargets: [],
};

export function validateAutomationConfig(value: unknown): AutomationConfig {
  if (value === undefined)
    return { ...DEFAULT_AUTOMATION_CONFIG, rankTargets: [] };
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Automation settings must be an object.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !Object.hasOwn(DEFAULT_AUTOMATION_CONFIG, key),
    )
  )
    throw new Error('Unsupported Automation setting.');
  const config = { ...DEFAULT_AUTOMATION_CONFIG, ...input } as AutomationConfig;
  if (!['fixed', 'random', 'humanized'].includes(config.timingMode))
    throw new Error('Choose Fixed, Random or Humanized timing.');
  for (const key of [
    'fixedIntervalSeconds',
    'randomMinSeconds',
    'randomMaxSeconds',
  ] as const) {
    if (
      !Number.isInteger(config[key]) ||
      config[key] < 2 ||
      config[key] > 86400
    ) {
      throw new Error(
        'Timing intervals must be whole seconds between 2 and 86400.',
      );
    }
  }
  if (config.randomMinSeconds > config.randomMaxSeconds)
    throw new Error('Random maximum must be at least its minimum.');
  if (
    !Number.isInteger(config.maxCyclesPerProfile) ||
    config.maxCyclesPerProfile < 1 ||
    config.maxCyclesPerProfile > 10
  ) {
    throw new Error(
      'Sandbox tests require a finite limit of 1 to 10 cycles per profile.',
    );
  }
  if (
    typeof config.maxTotalSpend !== 'number' ||
    !Number.isFinite(config.maxTotalSpend) ||
    config.maxTotalSpend < 10 ||
    config.maxTotalSpend > 8000 ||
    Math.abs(
      config.maxTotalSpend * 100 - Math.round(config.maxTotalSpend * 100),
    ) > 0.000001
  ) {
    throw new Error(
      'Sandbox test spend cap must be between RM10 and RM8000, with at most two decimal places.',
    );
  }
  if (!['mysg', 'global'].includes(config.humanizedRegion))
    throw new Error('Unsupported Humanized region mix.');
  config.rankTargets = validateRankTargets(config.rankTargets);
  if (
    typeof config.humanizedTestClock !== 'boolean' ||
    (config.humanizedTestClock &&
      (config.timingMode !== 'humanized' || config.rankTargets.length > 0))
  ) {
    throw new Error(
      'Accelerated test clock requires Humanized timing without leaderboard targets.',
    );
  }
  return config;
}

export function automationDelayMs(
  config: Pick<
    AutomationConfig,
    | 'timingMode'
    | 'fixedIntervalSeconds'
    | 'randomMinSeconds'
    | 'randomMaxSeconds'
  >,
  random = Math.random,
): number {
  if (config.timingMode === 'fixed') return config.fixedIntervalSeconds * 1000;
  return (
    (config.randomMinSeconds +
      Math.floor(
        random() * (config.randomMaxSeconds - config.randomMinSeconds + 1),
      )) *
    1000
  );
}
