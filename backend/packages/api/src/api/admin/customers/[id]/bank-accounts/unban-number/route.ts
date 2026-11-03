import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { hasPermission } from '@medusajs/framework';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';

type Body = {
  last4?: unknown;
  bank_code?: unknown;
  lifted?: unknown;
  reason?: unknown;
};

// POST /admin/customers/:id/bank-accounts/unban-number — support unbans a bank
// number FOR THIS PLAYER (owner, 2026-11-04): they may save it and be paid to
// it; it stays banned for every other account. Named by its last 4 (the bank
// only breaks a tie), among the player's own numbers or, for one whose save was
// refused, the whole ban list. `lifted: false` bans it for them again. Audited.
// The shared-number rule still applies: if another account was paid to it,
// support adds it with Add. Gated on assistant_unban:update (admin-rbac.ts);
// the ban-list fallback also needs customer:update (security review).
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const { last4, bank_code: bankCode, lifted = true, reason } = req.body ?? {};
  if (typeof last4 !== 'string' || !/^[0-9]{4}$/.test(last4)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Give the last 4 digits of the bank number.',
    );
  }
  if (
    bankCode !== undefined &&
    bankCode !== null &&
    typeof bankCode !== 'string'
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Pick a bank from the list.',
    );
  }
  if (typeof lifted !== 'boolean') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'lifted must be true or false.',
    );
  }
  if (
    typeof reason !== 'string' ||
    reason.trim() === '' ||
    reason.length > 500
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (1–500 chars) is required.',
    );
  }
  const roles =
    (
      req as unknown as {
        auth_context?: { app_metadata?: { roles?: string[] } };
      }
    ).auth_context?.app_metadata?.roles ?? [];
  // hasPermission answers true for an empty role list: never here.
  const fromBanList =
    roles.length > 0 &&
    (await hasPermission({
      roles,
      actions: { resource: 'customer', operation: 'update' },
      container: req.scope,
    }));
  const done = await req.scope
    .resolve<PacksModuleService>(PACKS_MODULE)
    .setPayoutBanLifted({
      customerId: req.params.id,
      adminId: req.auth_context.actor_id,
      last4,
      bankCode: bankCode || null,
      lifted,
      reason: reason.trim(),
      fromBanList,
    });
  res.json(done);
}
