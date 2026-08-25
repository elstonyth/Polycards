import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';

// POST /admin/referrals/settlements/:id/pay — "Pay now": runs the Wednesday
// step early for one approved run. Same idempotent path the cron takes;
// deleted-account voiding and the pay_settlement audit live inside
// payWeeklySettlement so the two callers can't drift. The post-commit
// auto-unfreeze sweep below mirrors the cron's for the same reason.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const warn = (message: string) => {
    try {
      req.scope.resolve(ContainerRegistrationKeys.LOGGER).error(message);
    } catch {
      // logger unavailable in test containers — ignore
    }
  };

  const result = await packs.payWeeklySettlement({
    settlementId: req.params.id,
    adminId: req.auth_context.actor_id,
  });

  // The commission credits were written outside mutateCreditAtomic, so they
  // skipped its inline auto-unfreeze. Lift an AUTO freeze whose debt this
  // payout repays — otherwise a paid referrer's available balance keeps reading
  // 0 and their wallet stays locked until some unrelated top-up happens to
  // reconcile it.
  //
  // Bare (no shared context) and only now that payWeeklySettlement has
  // committed: it runs as ONE transaction, so an in-loop call would hold a
  // `credit:<id>` advisory lock per customer until the whole run committed.
  //
  // Best-effort, per customer: the credit already committed, so a lingering
  // freeze is no worse than before and clears on the next inflow — never fail a
  // successful payout on the unfreeze check.
  for (const customerId of result.paid_customer_ids) {
    try {
      await packs.maybeAutoUnfreezeForCustomer(customerId);
    } catch (e: unknown) {
      warn(
        `[settlements/pay] auto-unfreeze check failed for '${customerId}' — payout stands: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  res.json(result);
}
