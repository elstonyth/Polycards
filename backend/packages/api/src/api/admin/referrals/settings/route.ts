import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import type { ReferralTier } from '../../../../modules/packs/referral';
import { reqReason } from '../../rewards-settings/validate';

// GET /admin/referrals/settings — the commission tier table + partner bounds.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.getReferralSettings());
}

// POST /admin/referrals/settings — audited edit. Structural validation here;
// the business rules (sorted tiers, first at 0, bp ranges, min<max) live in
// editReferralSettings so every caller shares them.
export async function POST(
  req: AuthenticatedMedusaRequest<{
    tiers?: unknown;
    partner_min_bp?: unknown;
    partner_max_bp?: unknown;
    reason?: unknown;
  }>,
  res: MedusaResponse,
): Promise<void> {
  const adminId = req.auth_context.actor_id;
  const reason = reqReason(req.body);
  const body = req.body ?? {};

  let tiers: ReferralTier[] | undefined;
  if (body.tiers !== undefined) {
    if (
      !Array.isArray(body.tiers) ||
      body.tiers.some(
        (t) =>
          typeof t !== 'object' ||
          t === null ||
          typeof (t as ReferralTier).min_cents !== 'number' ||
          typeof (t as ReferralTier).rate_bp !== 'number',
      )
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'tiers must be an array of { min_cents, rate_bp } numbers.',
      );
    }
    tiers = (body.tiers as ReferralTier[]).map((t) => ({
      min_cents: t.min_cents,
      rate_bp: t.rate_bp,
    }));
  }
  const numOrUndefined = (v: unknown, name: string): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${name} must be a number.`,
      );
    }
    return v;
  };

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.editReferralSettings({
    tiers,
    partner_min_bp: numOrUndefined(body.partner_min_bp, 'partner_min_bp'),
    partner_max_bp: numOrUndefined(body.partner_max_bp, 'partner_max_bp'),
    adminId,
    reason,
  });
  res.json(await packs.getReferralSettings());
}
