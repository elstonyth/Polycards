import {
  automationDelayMs,
  DEFAULT_AUTOMATION_CONFIG,
  validateAutomationConfig,
} from '../automation-config';

it('keeps bounded defaults and permits only finite validated local settings', () => {
  expect(validateAutomationConfig(undefined)).toEqual(
    DEFAULT_AUTOMATION_CONFIG,
  );
  expect(
    validateAutomationConfig({ maxCyclesPerProfile: 10, maxTotalSpend: 8000 }),
  ).toMatchObject({ maxCyclesPerProfile: 10 });
  for (const input of [
    null,
    [],
    { maxCyclesPerProfile: 0 },
    { maxCyclesPerProfile: 11 },
    { maxCyclesPerProfile: 1.5 },
    { fixedIntervalSeconds: 0 },
    { fixedIntervalSeconds: 86401 },
    { randomMinSeconds: 10, randomMaxSeconds: 5 },
    { maxTotalSpend: NaN },
    { maxTotalSpend: 10.001 },
    { maxTotalSpend: 8000.01 },
    { timingMode: 'legacy' },
    { humanizedRegion: 'remote' },
    { api_url: 'https://example.com' },
    { toString: 'override' },
    JSON.parse('{"__proto__":{}}'),
  ])
    expect(() => validateAutomationConfig(input)).toThrow();
});

it('samples each Random interval once within inclusive bounds and keeps Fixed exact', () => {
  const config = {
    ...DEFAULT_AUTOMATION_CONFIG,
    timingMode: 'random' as const,
    randomMinSeconds: 3,
    randomMaxSeconds: 9,
  };
  expect(automationDelayMs(config, () => 0)).toBe(3000);
  expect(automationDelayMs(config, () => 0.999)).toBe(9000);
  expect(automationDelayMs(DEFAULT_AUTOMATION_CONFIG, () => 0.9)).toBe(2000);
});

it('permits an explicit test clock only for Humanized runs without leaderboard targets', () => {
  expect(
    validateAutomationConfig({
      timingMode: 'humanized',
      humanizedTestClock: true,
    }),
  ).toMatchObject({ humanizedTestClock: true });
  expect(validateAutomationConfig(undefined).humanizedTestClock).toBe(false);
  for (const input of [
    { humanizedTestClock: true },
    { timingMode: 'humanized', humanizedTestClock: 'true' },
    {
      timingMode: 'humanized',
      humanizedTestClock: true,
      rankTargets: [
        {
          profileId: 'profile-0',
          period: 'weekly',
          mode: 'test',
          goal: 'reach',
          targetRank: 1,
          secureBufferMyr: 20,
          threatBufferMyr: 5,
          maxCycles: 1,
          maxSpendMyr: 10,
          maxDurationMinutes: 1,
        },
      ],
    },
  ]) {
    expect(() => validateAutomationConfig(input)).toThrow();
  }
});
