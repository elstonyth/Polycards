import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { parsePaginationParams } from '../../../../../utils/pagination';

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const { limit, offset } = parsePaginationParams({
    limit: req.query.limit,
    offset: req.query.offset,
  });
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const audit = await packs.auditForCustomer(id, { limit, offset });
  // Who did it, by email: a deleted staff login falls back to its id on screen.
  const adminIds = [...new Set(audit.actions.map((a) => a.admin_id))];
  const staff = adminIds.length
    ? await req.scope
        .resolve(Modules.USER)
        .listUsers(
          { id: adminIds },
          { select: ['id', 'email'], take: adminIds.length },
        )
    : [];
  const emailById = new Map(staff.map((u) => [u.id, u.email]));
  res.json({
    ...audit,
    actions: audit.actions.map((a) => ({
      ...a,
      admin_email: emailById.get(a.admin_id) ?? null,
    })),
  });
}
