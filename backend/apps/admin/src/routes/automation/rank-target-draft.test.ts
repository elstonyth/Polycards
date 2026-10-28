import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION_CONFIG } from '../../../../../packages/api/src/api/utils/automation-config';
import {
  DEFAULT_RANK_TARGET,
  configForProfiles,
  profileCycleLimit,
  runProfileIds,
  saveRankTarget,
} from './rank-target-draft';

const first = { ...DEFAULT_RANK_TARGET, profileId: 'profile-1' };
const second = { ...DEFAULT_RANK_TARGET, profileId: 'profile-2' };
describe('Leaderboard target drafts', () => {
  it('defaults to preview and only accepts an imported profile', () => {
    expect(first.mode).toBe('shadow');
    expect(saveRankTarget([], first, null, ['profile-1'])).toEqual([first]);
    expect(() => saveRankTarget([], first, null, ['profile-2'])).toThrow(
      'test profile',
    );
  });
  it('edits one target without losing others and rejects duplicate accounts', () => {
    expect(
      saveRankTarget(
        [first, second],
        { ...first, targetRank: 5 },
        first.profileId,
        ['profile-1', 'profile-2'],
      ),
    ).toEqual([second, { ...first, targetRank: 5 }]);
    expect(() => saveRankTarget([first], first, null, ['profile-1'])).toThrow();
  });
  it('uses shared validation for invalid limits and conflicting active targets', () => {
    expect(() =>
      saveRankTarget([], { ...first, threatBufferMyr: 21 }, null, [
        'profile-1',
      ]),
    ).toThrow();
    expect(() =>
      saveRankTarget(
        [{ ...first, mode: 'test', targetRank: 1 }],
        { ...second, mode: 'test', targetRank: 1 },
        null,
        ['profile-1', 'profile-2'],
      ),
    ).toThrow('conflict');
  });
  it('runs only included targets while preserving the full configuration draft', () => {
    const config = {
      ...DEFAULT_AUTOMATION_CONFIG,
      rankTargets: [first, second],
    };
    expect(configForProfiles(config, 'profile-2').rankTargets).toEqual([
      second,
    ]);
    expect(configForProfiles(config, 'all').rankTargets).toEqual([
      first,
      second,
    ]);
    expect(config.rankTargets).toHaveLength(2);
    expect(runProfileIds(config, 'all')).toEqual(['profile-1', 'profile-2']);
    expect(runProfileIds(config, 'profile-2')).toEqual(['profile-2']);
    expect(() => runProfileIds(config, 'profile-3')).toThrow('no target');
    expect(runProfileIds(DEFAULT_AUTOMATION_CONFIG, 'all')).toBeUndefined();
    expect(runProfileIds(DEFAULT_AUTOMATION_CONFIG, 'profile-3')).toEqual([
      'profile-3',
    ]);
  });
  it('shows zero cycles for read-only modes and the smaller limit for sandbox tests', () => {
    const config = {
      ...DEFAULT_AUTOMATION_CONFIG,
      maxCyclesPerProfile: 2,
      rankTargets: [first],
    };
    expect(profileCycleLimit(config, first.profileId)).toBe(0);
    expect(
      profileCycleLimit(
        { ...config, rankTargets: [{ ...first, mode: 'test' }] },
        first.profileId,
      ),
    ).toBe(2);
    expect(profileCycleLimit(config, 'profile-2')).toBe(2);
  });
  it('caps both displayed counts to affordable RM10 fixture cycles', () => {
    const config = {
      ...DEFAULT_AUTOMATION_CONFIG,
      maxCyclesPerProfile: 5,
      rankTargets: [
        { ...first, mode: 'test' as const, maxCycles: 5, maxSpendMyr: 10 },
      ],
    };
    expect(profileCycleLimit(config, first.profileId)).toBe(1);
    config.rankTargets[0].maxSpendMyr = 29.99;
    expect(profileCycleLimit(config, first.profileId)).toBe(2);
    config.rankTargets[0].maxSpendMyr = 100;
    expect(profileCycleLimit(config, first.profileId)).toBe(5);
  });
});
