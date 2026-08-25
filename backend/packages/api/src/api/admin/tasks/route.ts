import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { reqReason } from '../rewards-settings/validate';
import { resolveTaskLabels } from './labels';

// GET /admin/tasks — every definition (active and retired), sorted. Each row
// carries plain-English `labels` so the console can render a task without
// pulling the pack / card / pixel catalogs into the browser.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.listTaskDefinitions(
    {},
    { order: { sort: 'ASC' }, take: 500 },
  );
  const labels = await resolveTaskLabels(packs, rows);
  res.json({
    tasks: rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      requirement: t.requirement,
      reward: t.reward,
      active: t.active,
      sort: t.sort,
      starts_at: t.starts_at ? new Date(t.starts_at).toISOString() : null,
      ends_at: t.ends_at ? new Date(t.ends_at).toISOString() : null,
      labels: labels.get(t.id) ?? { requirement: '', reward: '' },
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
    starts_at?: unknown;
    ends_at?: unknown;
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
  // An unparseable date must not silently become "no window" — that would
  // publish a task the operator meant to schedule for later.
  const when = (v: unknown, field: string): Date | null => {
    if (v == null || v === '') return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${field} must be an ISO date-time.`,
      );
    }
    return d;
  };
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { id } = await packs.saveTaskDefinition({
    id: typeof b.id === 'string' ? b.id : undefined,
    kind: b.kind,
    title: b.title,
    requirement: b.requirement,
    reward: b.reward,
    active: b.active !== false,
    sort: typeof b.sort === 'number' && Number.isInteger(b.sort) ? b.sort : 0,
    startsAt: when(b.starts_at, 'starts_at'),
    endsAt: when(b.ends_at, 'ends_at'),
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ id });
}
