import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { validateChallengeStages } from '../../../../modules/packs/challenge-validate';
import type { ChallengeRankReward } from '../../../../modules/packs/challenge-validate';
import { reqReason } from '../../rewards-settings/validate';

// GET /admin/challenge/stages — all milestone stages ordered by stage_number.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.listChallengeStages(
    {},
    {
      select: ['stage_number', 'threshold_myr', 'rank_rewards'],
      take: 1000,
    },
  );
  const stages = rows
    .map((r) => ({
      stage_number: r.stage_number,
      threshold_myr: Number(r.threshold_myr),
      rank_rewards: ((r.rank_rewards as unknown as ChallengeRankReward[]) ?? [])
        .slice()
        .sort((a, b) => a.rank - b.rank),
    }))
    .sort((a, b) => a.stage_number - b.stage_number);
  res.json({ stages });
}

// POST /admin/challenge/stages — audited whole-set replace. admin_id from
// auth_context, NEVER the body.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const adminId = req.auth_context.actor_id;
  const reason = reqReason(req.body);
  const stages = validateChallengeStages(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const saved = await packs.saveChallengeStages({ stages, adminId, reason });
  res.json({ stages: saved });
}
