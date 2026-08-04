import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// DELETE /admin/challenge/schedule/:id — drop a queued edition before it goes
// live. An ALREADY-PROMOTED row is refused: deleting it would not un-apply
// anything (its stages are the live challenge now) but would erase the record
// of why the live ladder changed. To undo a promotion, edit the live stages.
export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const [row] = await packs.listChallengeSchedules(
    { id },
    { select: ['id', 'applied_at'], take: 1 },
  );
  if (!row)
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'Scheduled challenge not found.',
    );
  if (row.applied_at)
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This challenge already went live — edit the live stages instead.',
    );

  await packs.deleteChallengeSchedules([id]);
  res.json({ id, deleted: true });
}
