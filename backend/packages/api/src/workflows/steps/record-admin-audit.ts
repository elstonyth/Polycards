import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import type { AdminAuditRow } from '../../modules/packs/service';

// record-admin-audit — the LAST step of every pack / odds config workflow.
//
// Being last is the guarantee: if the row cannot be written (a CHECK the
// migration has not widened yet, a DB blip), this step throws and the engine
// compensates the change steps before it, so the operator sees the save fail
// instead of a change landing with no record. No compensation of its own —
// nothing runs after it.
//
// null = the change step found nothing to record (e.g. a save that changed
// no row); the workflow still succeeds.
export const recordAdminAuditInvoke = async (
  row: AdminAuditRow | null,
  { container }: { container: MedusaContainer },
) => {
  if (!row) return new StepResponse(undefined);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.createAdminActionAudits([row]);
  return new StepResponse(undefined);
};

export const recordAdminAuditStep = createStep(
  'record-admin-audit',
  recordAdminAuditInvoke,
);

export default recordAdminAuditStep;
