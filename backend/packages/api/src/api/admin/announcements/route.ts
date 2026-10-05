import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { reqReason } from '../rewards-settings/validate';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

// GET /admin/announcements — every non-deleted announcement (live, scheduled,
// switched off), in the order the storefront carousel would show them.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.listAnnouncements(
    {},
    { order: { sort: 'ASC', created_at: 'DESC' }, take: 500 },
  );
  res.json({
    announcements: rows.map((a) => ({
      id: a.id,
      image_url: a.image_url,
      title: a.title,
      link_url: a.link_url,
      active: a.active,
      sort: a.sort,
      starts_at: iso(a.starts_at),
      ends_at: iso(a.ends_at),
      updated_at: iso(a.updated_at),
    })),
  });
}

// POST /admin/announcements — create (no id) or update (with id). Validation
// + audit live in saveAnnouncement.
export async function POST(
  req: AuthenticatedMedusaRequest<{
    id?: unknown;
    image_url?: unknown;
    title?: unknown;
    link_url?: unknown;
    active?: unknown;
    sort?: unknown;
    starts_at?: unknown;
    ends_at?: unknown;
    reason?: unknown;
  }>,
  res: MedusaResponse,
): Promise<void> {
  const b = req.body ?? {};
  if (typeof b.image_url !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'image_url is required.',
    );
  }
  const text = (v: unknown, field: string): string | null => {
    if (v == null) return null;
    if (typeof v !== 'string') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${field} must be a string or null.`,
      );
    }
    return v;
  };
  // An unparseable date must not silently become "no window" — that would
  // publish an announcement the operator meant to schedule for later.
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
  // An update rewrites every field, so a missing or mistyped active/sort must
  // be refused, not defaulted — "on" / 0 would quietly re-publish a slide the
  // operator switched off. Only a create may omit them (on, sort 0).
  const editId = typeof b.id === 'string' ? b.id : undefined;
  const isUpdate = editId !== undefined;
  if (typeof b.active !== 'boolean' && (isUpdate || b.active !== undefined)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'active must be true or false.',
    );
  }
  const sortOk = typeof b.sort === 'number' && Number.isInteger(b.sort);
  if (!sortOk && (isUpdate || b.sort !== undefined)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'sort must be a whole number.',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { id } = await packs.saveAnnouncement({
    id: editId,
    image_url: b.image_url,
    title: text(b.title, 'title'),
    link_url: text(b.link_url, 'link_url'),
    active: typeof b.active === 'boolean' ? b.active : true,
    sort: typeof b.sort === 'number' ? b.sort : 0,
    startsAt: when(b.starts_at, 'starts_at'),
    endsAt: when(b.ends_at, 'ends_at'),
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ id });
}
