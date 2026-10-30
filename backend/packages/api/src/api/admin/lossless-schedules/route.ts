import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { FREE_WELCOME_CATEGORY } from '../../../modules/packs/free-pack';
import {
  REWARD_BOX_CATEGORY,
  effectiveEndMs,
  losslessStatus,
} from '../../../modules/packs/lossless';
import type { LosslessStatus } from '../../../modules/packs/lossless';
import { reqReason } from '../rewards-settings/validate';
import { parseLosslessSchedule } from './validate';

// Lossless Mode windows: while one is live, the chosen packs' INSTANT sell pays
// 100%. The pricing reads the table (lossless.ts); this route only schedules.

export interface LosslessScheduleView {
  id: string;
  starts_at: string;
  ends_at: string;
  /** ends_at, or the cancel time if that came first — when it stops applying. */
  effective_end: string;
  pack_slugs: string[] | null;
  cancelled_at: string | null;
  created_by: string;
  /** Decided HERE, off one `now` per response, so the browser's clock never
   *  decides whether a window is live. */
  status: LosslessStatus;
}

export const view = (
  r: {
    id: string;
    starts_at: Date | string;
    ends_at: Date | string;
    cancelled_at: Date | string | null;
    pack_slugs: unknown;
    created_by: string;
  },
  now: number,
): LosslessScheduleView => {
  const w = {
    id: r.id,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    cancelled_at: r.cancelled_at,
    pack_slugs: r.pack_slugs as string[] | null,
  };
  return {
    id: r.id,
    starts_at: new Date(r.starts_at).toISOString(),
    ends_at: new Date(r.ends_at).toISOString(),
    effective_end: new Date(effectiveEndMs(w)).toISOString(),
    pack_slugs: w.pack_slugs,
    cancelled_at:
      r.cancelled_at == null ? null : new Date(r.cancelled_at).toISOString(),
    created_by: r.created_by,
    status: losslessStatus(w, now),
  };
};

// GET /admin/lossless-schedules — newest start first, capped at 100: this is a
// short operator list, not an archive.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.listLosslessSchedules(
    {},
    { order: { starts_at: 'DESC' }, take: 100 },
  );
  const now = Date.now();
  res.json({ schedules: rows.map((r) => view(r, now)) });
}

// POST /admin/lossless-schedules — schedule a window. The row and its audit
// ride one service transaction (createLosslessSchedule).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const adminId = req.auth_context.actor_id;
  const reason = reqReason(req.body);
  const { startsAt, endsAt, packSlugs } = parseLosslessSchedule(
    req.body,
    Date.now(),
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // A typo'd slug would save a window that silently does nothing; the free
  // welcome pack and reward boxes are promo grants that never get lossless, so
  // naming one is a mistake too. Report the first offender, in request order.
  if (packSlugs) {
    const found = new Map(
      (
        await packs.listPacks(
          { slug: packSlugs },
          { select: ['slug', 'category', 'prize_type'] },
        )
      ).map((p) => [p.slug, p]),
    );
    const ticketPack = packSlugs.find(
      (slug) => found.get(slug)?.prize_type === 'tickets',
    );
    if (ticketPack !== undefined)
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${ticketPack} is a ticket pack. It has no buyback, so it cannot get a Lossless window.`,
      );
    const bad = packSlugs.find((slug) => {
      const category = found.get(slug)?.category;
      return (
        category === undefined ||
        category === FREE_WELCOME_CATEGORY ||
        category === REWARD_BOX_CATEGORY
      );
    });
    if (bad !== undefined)
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unknown or ineligible pack: ${bad}`,
      );
  }

  const { id } = await packs.createLosslessSchedule({
    startsAt,
    endsAt,
    packSlugs,
    adminId,
    reason,
  });
  // The service threw if the insert did not land, so these ARE the row's
  // values; through view() so the shape cannot drift from GET's.
  res.json({
    schedule: view(
      {
        id,
        starts_at: startsAt,
        ends_at: endsAt,
        cancelled_at: null,
        pack_slugs: packSlugs,
        created_by: adminId,
      },
      Date.now(),
    ),
  });
}
