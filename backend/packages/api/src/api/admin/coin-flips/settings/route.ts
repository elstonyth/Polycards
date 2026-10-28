import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { reqReason } from '../../rewards-settings/validate';

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  res.json(await req.scope.resolve<PacksModuleService>(PACKS_MODULE).coinFlipSettings());
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const reason = reqReason(req.body);
  const body = req.body as Record<string, unknown>;
  if (typeof body.expected_revision !== 'number' || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'A saved settings revision is required.');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.saveCoinFlipSettings({ settings: body, revision: body.expected_revision, reason, adminId: req.auth_context.actor_id }));
}
