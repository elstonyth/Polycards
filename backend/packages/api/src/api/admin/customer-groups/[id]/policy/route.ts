import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { editGroupPolicy } from '../../../../../modules/packs/player-groups';
import { reqReason } from '../../../rewards-settings/validate';

type Body = {
  partner_rate_bp?: unknown;
  withdrawals_blocked?: unknown;
  verification_exempt?: unknown;
  reason?: unknown;
};

/**
 * POST /admin/customer-groups/:id/policy — set a player group's partner
 * policy (spec 2026-09-09).
 *
 * Body: `{ partner_rate_bp: number | null, withdrawals_blocked: boolean,
 * verification_exempt: boolean, reason: string }`. A null rate turns the
 * group back into an ordinary group and clears both toggles. Bounds, the
 * DEFAULT-group refusal and the audit row live in editGroupPolicy.
 *
 * A repo route rather than a metadata write through the native
 * POST /admin/customer-groups/:id, because that route validates nothing about
 * these keys and audits nothing — and this one changes whether a player can
 * take money out.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const body = req.body ?? {};
  const rate = body.partner_rate_bp ?? null;
  if (rate !== null && typeof rate !== 'number') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'partner_rate_bp must be a number or null.',
    );
  }
  for (const key of ['withdrawals_blocked', 'verification_exempt'] as const) {
    const v = body[key];
    if (v !== undefined && typeof v !== 'boolean') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${key} must be a boolean.`,
      );
    }
  }
  const group = await editGroupPolicy(req.scope, {
    groupId: req.params.id,
    policy: {
      partner_rate_bp: rate,
      withdrawals_blocked: body.withdrawals_blocked === true,
      verification_exempt: body.verification_exempt === true,
    },
    adminId: req.auth_context.actor_id,
    reason: reqReason(body),
  });
  res.json({
    customer_group: {
      id: group.id,
      name: group.name,
      metadata: group.metadata ?? null,
    },
  });
}
