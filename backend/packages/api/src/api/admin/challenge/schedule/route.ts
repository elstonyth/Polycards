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

// How much promoted history to show beside the queue. Enough to answer "why did
// the ladder change?" without letting old rows crowd out pending ones.
const HISTORY_LIMIT = 20;
const QUEUE_LIMIT = 100;

// GET /admin/challenge/schedule — the queue, soonest first, plus a little
// already-promoted history: the operator needs to see that last week's edition
// went live, and a row that FAILED to promote is exactly a due row still
// unstamped.
//
// TWO queries, not one ordered window. A single `order: starts_at ASC, take:
// 100` puts the OLDEST rows first — so once ~100 editions have accumulated
// (two years of weekly use) every newly queued row falls outside the window and
// the Scheduled tab silently stops showing it. An operator whose entry does not
// appear queues it again, which is the worst possible failure for a table that
// replaces the live prize ladder.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const select = ['id', 'starts_at', 'label', 'applied_at', 'stages'];
  // Sequential, not Promise.all: both resolve the same injected manager, and
  // overlapping them is two concurrent queries on one connection — this repo's
  // "pool is probably full" shape (same rule as settleChallengeWeek's reads).
  const pending = await packs.listChallengeSchedules(
    { applied_at: null },
    { select, order: { starts_at: 'ASC' }, take: QUEUE_LIMIT },
  );
  const history = await packs.listChallengeSchedules(
    { applied_at: { $ne: null } },
    { select, order: { starts_at: 'DESC' }, take: HISTORY_LIMIT },
  );
  // Queue first, in the order it will fire — a due-but-unstamped row (a
  // promotion that threw) sorts to the very top, which is where the one row
  // needing a person belongs. Promoted history follows as the record.
  res.json({ schedules: [...pending.map(view), ...history.map(view)] });
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
