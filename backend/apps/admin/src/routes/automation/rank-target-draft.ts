import type {
  AutomationConfig,
  AutomationRankTarget,
} from '../../../../../packages/api/src/api/utils/automation-types';
import { validateRankTargets } from '../../../../../packages/api/src/api/utils/automation-rank';

export const DEFAULT_RANK_TARGET: Omit<AutomationRankTarget, 'profileId'> = {
  period: 'weekly',
  mode: 'shadow',
  goal: 'reach',
  targetRank: 3,
  secureBufferMyr: 20,
  threatBufferMyr: 5,
  maxCycles: 3,
  maxSpendMyr: 30,
  maxDurationMinutes: 15,
};

export function saveRankTarget(
  targets: AutomationRankTarget[],
  draft: AutomationRankTarget,
  editingProfileId: string | null,
  profileIds: string[],
): AutomationRankTarget[] {
  if (!profileIds.includes(draft.profileId))
    throw new Error('Choose an test profile.');
  return validateRankTargets([
    ...targets.filter((target) => target.profileId !== editingProfileId),
    draft,
  ]);
}

export function configForProfiles(
  config: AutomationConfig,
  selectedProfile: string,
): AutomationConfig {
  return {
    ...config,
    rankTargets: (config.rankTargets ?? []).filter(
      (target) =>
        selectedProfile === 'all' || target.profileId === selectedProfile,
    ),
  };
}

export function runProfileIds(
  config: AutomationConfig,
  selectedProfile: string,
): string[] | undefined {
  if (!config.rankTargets?.length)
    return selectedProfile === 'all' ? undefined : [selectedProfile];
  const ids = configForProfiles(config, selectedProfile).rankTargets!.map(
    (target) => target.profileId,
  );
  if (ids.length === 0)
    throw new Error(
      'The selected account has no target. Choose an account with a target or select all imported profiles.',
    );
  return ids;
}

export function profileCycleLimit(
  config: AutomationConfig,
  profileId: string,
): number {
  const target = config.rankTargets?.find(
    (target) => target.profileId === profileId,
  );
  // Sandbox test fixtures charge RM10 per cycle, matching the runner's planned count.
  return target
    ? target.mode === 'test'
      ? Math.min(
          config.maxCyclesPerProfile,
          target.maxCycles,
          Math.floor(target.maxSpendMyr / 10),
        )
      : 0
    : config.maxCyclesPerProfile;
}
