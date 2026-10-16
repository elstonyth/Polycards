import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { reqReason } from '../../../rewards-settings/validate';
import { view } from '../../route';

// POST /admin/lossless-schedules/:id/cancel — end a window now. The lock, the
// stamp and the audit row live in ONE service transaction; a window that
// already ended or was cancelled is refused there (NOT_ALLOWED -> 400).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const adminId = req.auth_context.actor_id;
  const reason = reqReason(req.body);
  const { id } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  await packs.cancelLosslessSchedule({ id, adminId, reason });

  // Re-read so the response carries the stored row (created_by, the stamped
  // cancelled_at), not a reconstruction.
  const [row] = await packs.listLosslessSchedules({ id }, { take: 1 });
  if (!row)
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'Lossless schedule not found.',
    );
  res.json({ schedule: view(row, Date.now()) });
}
