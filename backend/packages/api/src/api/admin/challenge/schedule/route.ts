import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { validateChallengeStages } from '../../../../modules/packs/challenge-validate';
import type { ChallengeRankReward } from '../../../../modules/packs/challenge-validate';
import { reqReason } from '../../rewards-settings/validate';

// The queue of Weekly Challenges waiting to go live. The LIVE one stays at
// /admin/challenge/stages — this route never touches it; the hourly settle job
// promotes a due row (see promoteDueChallengeSchedules).

const MAX_LABEL = 120;

export interface ScheduleView {
  id: string;
  starts_at: string;
  label: string | null;
  applied_at: string | null;
  stages: {
    stage_number: number;
    threshold_myr: number;
    rank_rewards: ChallengeRankReward[];
  }[];
}

const view = (r: {
  id: string;
  starts_at: Date | string;
  label: string | null;
  applied_at: Date | string | null;
  stages: unknown;
}): ScheduleView => ({
  id: r.id,
  starts_at: new Date(r.starts_at).toISOString(),
  label: r.label,
  applied_at:
    r.applied_at === null ? null : new Date(r.applied_at).toISOString(),
  stages: (r.stages as ScheduleView['stages']) ?? [],
});

// GET /admin/challenge/schedule — the queue, soonest first. Already-promoted
// rows come back too (with applied_at set): the operator needs to see that last
// week's edition went live, and a row that FAILED to promote is exactly a due
// row that is still unstamped.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.listChallengeSchedules(
    {},
    {
      select: ['id', 'starts_at', 'label', 'applied_at', 'stages'],
      order: { starts_at: 'ASC' },
      take: 100,
    },
  );
  res.json({ schedules: rows.map(view) });
}

// POST /admin/challenge/schedule — queue one. Same stage validation as the
// live save, so an edition can never be scheduled in a shape the promotion
// would then reject.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const adminId = req.auth_context.actor_id;
  const reason = reqReason(req.body);
  const body = req.body as {
    starts_at?: unknown;
    label?: unknown;
  } | null;

  if (typeof body?.starts_at !== 'string')
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'starts_at must be an ISO date-time string.',
    );
  const startsAt = new Date(body.starts_at);
  if (Number.isNaN(startsAt.getTime()))
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'starts_at must be an ISO date-time string.',
    );
  // A start in the past would be promoted by the very next tick, which is a
  // surprising way to replace the live challenge. Refuse rather than guess —
  // the operator can always edit the live stages directly if that is the
  // intent.
  if (startsAt.getTime() <= Date.now())
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'starts_at must be in the future.',
    );

  let label: string | null = null;
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== 'string')
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'label must be a string.',
      );
    label = body.label.trim().slice(0, MAX_LABEL) || null;
  }

  const stages = validateChallengeStages(req.body);

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [created] = await packs.createChallengeSchedules([
    {
      starts_at: startsAt,
      label,
      // model.json() generates a Record<string, unknown> create input — a plain
      // array has no string index signature, so it needs the same double-cast
      // saveChallengeStages uses for rank_rewards.
      stages: stages as unknown as Record<string, unknown>,
    },
  ]);
  await packs.createAdminActionAudits([
    {
      admin_id: adminId,
      entity_type: 'challenge_stages',
      entity_id: created.id,
      // 'create', not a new 'schedule' verb: the action enum is a DB CHECK, so
      // widening it costs a migration to say nothing the entity_id + payload
      // do not already say.
      action: 'create',
      before: null,
      after: { starts_at: startsAt.toISOString(), label, stages },
      reason,
    },
  ]);
  res.json({ schedule: view({ ...created, applied_at: null }) });
}
