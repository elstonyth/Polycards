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

  // Delete on a FILTER that repeats the unapplied condition, not on the id
  // alone. The check above and the delete are separate statements, and the
  // hourly promotion runs between them often enough to matter: it stamps the
  // row and replaces the live ladder, and an id-only delete would then erase
  // the record of an edition that had just gone live. Losing the race here
  // deletes nothing.
  await packs.deleteChallengeSchedules({ id, applied_at: null });

  // Re-read to find out who won. A no-op delete is not an error the operator
  // caused, but it must not be reported as a success either — the row they
  // tried to drop is now the live challenge.
  const [after] = await packs.listChallengeSchedules(
    { id },
    { select: ['id', 'applied_at'], take: 1 },
  );
  if (after)
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This challenge went live while you were removing it — edit the live stages instead.',
    );
  res.json({ id, deleted: true });
}
