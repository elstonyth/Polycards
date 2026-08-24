import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { reqReason } from '../rewards-settings/validate';

// GET /admin/tasks — every definition (active and retired), sorted.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.listTaskDefinitions(
    {},
    { order: { sort: 'ASC' }, take: 500 },
  );
  res.json({
    tasks: rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      requirement: t.requirement,
      reward: t.reward,
      active: t.active,
      sort: t.sort,
    })),
  });
}

// POST /admin/tasks — create (no id) or update (with id). Validation +
// audit live in saveTaskDefinition.
export async function POST(
  req: AuthenticatedMedusaRequest<{
    id?: unknown;
    kind?: unknown;
    title?: unknown;
    requirement?: unknown;
    reward?: unknown;
    active?: unknown;
    sort?: unknown;
    reason?: unknown;
  }>,
  res: MedusaResponse,
): Promise<void> {
  const b = req.body ?? {};
  if (b.kind !== 'weekly' && b.kind !== 'achievement') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "kind must be 'weekly' or 'achievement'.",
    );
  }
  if (typeof b.title !== 'string') {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'title is required.');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { id } = await packs.saveTaskDefinition({
    id: typeof b.id === 'string' ? b.id : undefined,
    kind: b.kind,
    title: b.title,
    requirement: b.requirement,
    reward: b.reward,
    active: b.active !== false,
    sort: typeof b.sort === 'number' && Number.isInteger(b.sort) ? b.sort : 0,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ id });
}
