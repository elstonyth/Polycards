import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { hasPermission } from '@medusajs/framework';
import { MedusaError } from '@medusajs/framework/utils';
import { submitHeldWithdrawal } from '../../../../../../modules/packs/gateway-withdrawal';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { payerIpOf } from '../../../../../utils/payer-ip';

// POST /admin/payments/withdrawals/:id/approve — release a HELD payout to the
// gateway. Together with ./deny this is the only way a held row leaves that
// state (plan 094); the sweep never selects one.
//
// The decision, the claim, the submit and the refund-on-refusal all live in
// submitHeldWithdrawal (modules/packs/gateway-withdrawal.ts), beside
// startWithdrawal — the customer-initiated twin whose step 3 this resumes.
// What is left here is the request: who is asking (the framework's blanket
// '/admin' auth guard puts the actor on req.auth_context), from where, about
// which row.
//
// Rate-limited on the shared admin-action budget (src/api/middlewares.ts).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as { verify_device_peers?: unknown };
  // The peers the reviewer saw in the drawer, by id (ADR 0018).
  const seenPeers = Array.isArray(body.verify_device_peers)
    ? body.verify_device_peers.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      )
    : [];
  // Confirming a household is the review drawer's call, and the drawer needs
  // the bank read policy (ADR 0018): an approver without it is refused BEFORE
  // anything is paid, never approved with the tick silently dropped.
  if (seenPeers.length > 0) {
    const roles =
      (req.auth_context as { app_metadata?: { roles?: string[] } })
        .app_metadata?.roles ?? [];
    // hasPermission answers true for an empty role list: never here.
    const allowed =
      roles.length > 0 &&
      (await hasPermission({
        roles,
        actions: { resource: 'customer_bank_account', operation: 'read' },
        container: req.scope,
      }));
    if (!allowed) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Confirming a household needs access to bank details. Approve without the tick, or ask an admin who has it.',
      );
    }
  }
  const result = await submitHeldWithdrawal(req.scope, {
    withdrawalId: req.params.id,
    adminId: req.auth_context.actor_id,
    // The ADMIN's request IP, not the customer's — see the operation's own
    // note on why that is still the un-forgeable value the gateway wants.
    payerIp: payerIpOf(req),
  });
  // The reviewer confirmed that the accounts sharing this one's browser are
  // one household (ADR 0018): its later withdrawals are not held for them
  // again. Only when THIS approve went through (approved: true), so a refused
  // or already-handled one leaves no stamp. The payout is already submitted
  // by now, so a failed stamp is logged, never answered as a failed approve.
  if (seenPeers.length > 0 && result.approved === true) {
    const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
    try {
      const [row] = await packs.listGatewayWithdrawals(
        { id: req.params.id },
        { take: 1 },
      );
      if (row?.customer_id) {
        await packs.verifyDevicePeers({
          customerId: row.customer_id,
          // Only accounts the reviewer saw AND still unverified now: one that
          // joined the browser after the drawer opened was never reviewed.
          peerIds: (await packs.sharedDeviceHoldPeers(row.customer_id)).filter(
            (id) => seenPeers.includes(id),
          ),
          adminId: req.auth_context.actor_id,
          reason: `one household, confirmed approving held withdrawal ${row.id}`,
        });
      }
    } catch (error) {
      (req.scope.resolve('logger') as { warn: (m: string) => void }).warn(
        `[payments] withdrawal ${req.params.id} approved, but the household stamp failed (${(error as { code?: string })?.code ?? 'no code'})`,
      );
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
}
