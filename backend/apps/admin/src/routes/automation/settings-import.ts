import type { AutomationConfig } from '../../../../../packages/api/src/api/utils/automation-types';
import { validateAutomationConfig } from '../../../../../packages/api/src/api/utils/automation-config';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function number(value: unknown, label: string): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    String(value).trim() === ''
  ) {
    throw new Error(`${label} must be a number.`);
  }
  const result = Number(value);
  if (!Number.isFinite(result))
    throw new Error(`${label} must be a finite number.`);
  return result;
}

function seconds(value: unknown, unit: unknown, label: string): number {
  const multiplier =
    unit === 'Seconds'
      ? 1
      : unit === 'Minutes'
        ? 60
        : unit === 'Hours'
          ? 3600
          : null;
  if (multiplier === null)
    throw new Error(`${label} has an unsupported time unit.`);
  return number(value, label) * multiplier;
}

/** Only validated sandbox settings cross this boundary; never copy URLs or credentials. */
export function importAutomationSettings(
  text: string,
  current: AutomationConfig,
): { config: AutomationConfig; notes: string[] } {
  if (text.length > 65_536)
    throw new Error('Choose a settings JSON file smaller than 64 KB.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Choose a valid settings JSON file.');
  }
  if (!object(parsed)) throw new Error('Settings must be a JSON object.');
  const raw = object(parsed.config) ? parsed.config : parsed;
  const mode = raw.timingMode ?? raw.timing_mode;
  if (!['fixed', 'random', 'legacy', 'humanized'].includes(String(mode))) {
    throw new Error(
      'This file does not contain supported Automation timing settings.',
    );
  }
  const timingMode =
    mode === 'legacy' ? 'random' : (mode as AutomationConfig['timingMode']);
  const config = { ...current, timingMode, humanizedTestClock: false };
  const notes = [
    'Imported timing and sandbox limits. Browser settings, API URLs, credentials and pack selection were not imported.',
  ];
  if (raw.humanizedRegion !== undefined) {
    if (raw.humanizedRegion !== 'mysg' && raw.humanizedRegion !== 'global')
      throw new Error('Unsupported humanized region.');
    config.humanizedRegion = raw.humanizedRegion;
  } else if (raw.humanized_region_mix !== undefined) {
    if (
      !['mysg_only', 'mixed', 'asia_heavy', 'global_balanced'].includes(
        String(raw.humanized_region_mix),
      )
    ) {
      throw new Error('Unsupported humanized region mix.');
    }
    config.humanizedRegion =
      raw.humanized_region_mix === 'mysg_only' ? 'mysg' : 'global';
    if (raw.humanized_region_mix !== 'mysg_only')
      notes.push(
        'Desktop region mix maps to the sandbox Global schedule. Review the region before running.',
      );
  }
  if (timingMode === 'humanized')
    notes.push(
      'Sandbox Humanized uses regional activity sessions and persona delays. It may wait until the next activity session.',
    );
  if (raw.humanizedTestClock !== undefined) {
    if (typeof raw.humanizedTestClock !== 'boolean')
      throw new Error('Humanized test clock must be true or false.');
    config.humanizedTestClock = raw.humanizedTestClock;
    if (raw.humanizedTestClock)
      notes.push(
        'Accelerated sandbox test clock enabled. Session waits advance; test cycles retain their minimum interval.',
      );
  }
  if (
    raw.fixedIntervalSeconds !== undefined ||
    raw.fixed_interval_seconds !== undefined
  ) {
    config.fixedIntervalSeconds = number(
      raw.fixedIntervalSeconds ?? raw.fixed_interval_seconds,
      'Fixed interval',
    );
  } else if (raw.fixed_value !== undefined) {
    config.fixedIntervalSeconds = seconds(
      raw.fixed_value,
      raw.fixed_unit,
      'Fixed interval',
    );
  }
  if (
    raw.randomMinSeconds !== undefined ||
    raw.random_range_min_seconds !== undefined
  ) {
    config.randomMinSeconds = number(
      raw.randomMinSeconds ?? raw.random_range_min_seconds,
      'Random minimum',
    );
    config.randomMaxSeconds = number(
      raw.randomMaxSeconds ?? raw.random_range_max_seconds,
      'Random maximum',
    );
  } else if (raw.random_min_value !== undefined) {
    config.randomMinSeconds = seconds(
      raw.random_min_value,
      raw.random_min_unit,
      'Random minimum',
    );
    config.randomMaxSeconds = seconds(
      raw.random_max_value,
      raw.random_max_unit,
      'Random maximum',
    );
  } else if (mode === 'legacy' && raw.draw_min !== undefined) {
    config.randomMinSeconds = number(raw.draw_min, 'Random minimum');
    config.randomMaxSeconds = number(raw.draw_max, 'Random maximum');
  }
  const cycleMode =
    timingMode === 'fixed'
      ? raw.fixed_cycle_mode
      : timingMode === 'random'
        ? raw.random_cycle_mode
        : undefined;
  const cycleLimit =
    raw.maxCyclesPerProfile ??
    raw.draw_cycle_limit ??
    (timingMode === 'fixed'
      ? raw.fixed_cycle_limit
      : timingMode === 'random'
        ? raw.random_cycle_limit
        : undefined);
  if (
    cycleMode === 'UNLIMITED' ||
    (cycleLimit !== undefined && number(cycleLimit, 'Cycles') === 0)
  ) {
    throw new Error(
      'This file requests unlimited cycles. Sandbox tests require a limit of 1–10 cycles per profile; set that limit before importing.',
    );
  }
  if (cycleLimit !== undefined)
    config.maxCyclesPerProfile = number(cycleLimit, 'Cycles');
  else
    notes.push(
      `No finite cycle limit was supplied. Kept the visible sandbox limit of ${current.maxCyclesPerProfile} cycle(s) per profile.`,
    );
  if (raw.maxTotalSpend !== undefined)
    config.maxTotalSpend = number(raw.maxTotalSpend, 'Spend limit');
  else if (raw.qa_max_spend_per_run_session !== undefined) {
    const spend = number(raw.qa_max_spend_per_run_session, 'Spend limit');
    if (spend !== 0) config.maxTotalSpend = spend;
    else
      notes.push(
        `Desktop spend cap is disabled. Kept the visible sandbox cap of RM${current.maxTotalSpend}.`,
      );
  }
  if (raw.rankTargets !== undefined)
    notes.push(
      'Imported sandbox rank targets. Review the account mapping and run mode before starting.',
    );
  else
    notes.push(
      'Existing sandbox rank targets were kept. Desktop rank targets must be configured here using test profile IDs.',
    );
  return {
    config: validateAutomationConfig({
      ...config,
      ...(raw.rankTargets !== undefined
        ? { rankTargets: raw.rankTargets }
        : {}),
    }),
    notes,
  };
}
