import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { rewardsRedemptionEnabled } from '../../../../modules/packs/rewards-gate';
import {
  isMalaysianAddress,
  MY_ONLY_MESSAGE,
} from '../../../../modules/packs/delivery';

// POST /store/rewards/withdraw — ship a vaulted reward-prize Pull as a physical
// delivery. Body: { pull_id, address: { firstName, lastName, address1, city,
// postalCode, countryCode } } — a free-form address the customer types for THIS
// shipment (not a saved-address id). This is the simpler, correct UX: the prize
// is already theirs, so the address is just where they want it sent.
//
// ENV-GATED (spec §13): like claim + draw, withdraw 403s while the global
// REWARDS_REDEMPTION_ENABLED flag is off. The economy is dormant until Phase P,
// and no legitimate prize can exist to ship before launch, so shipping stays
// dark too. recordRewardWithdrawal re-checks the gate (defense-in-depth); the
// per-customer withdrawals_per_day cap still applies once redemption is live.
//
// OWNERSHIP / SECURITY: the address is the customer's chosen destination for
// their own prize, so it carries no ownership decision. The real security
// boundary is recordRewardWithdrawal, which re-reads the Pull UNDER the lock and
// rejects it unless owned + source='reward' + 'vaulted'. The route only maps the
// camelCase body into the snake_case shape snapshotAddress expects and validates
// the required fields are present (400 INVALID_DATA otherwise).
//
// AUTH + RATE LIMIT: registered in api/middlewares.ts. The customer id comes ONLY
// from the verified bearer token, never the body.
type WithdrawAddressBody = {
  firstName?: unknown;
  lastName?: unknown;
  address1?: unknown;
  city?: unknown;
  postalCode?: unknown;
  countryCode?: unknown;
};

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  // Global redemption gate — fail closed while the economy is dormant.
  if (!rewardsRedemptionEnabled()) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Reward redemption is not enabled yet.',
    );
  }

  const body = req.body as
    | { pull_id?: unknown; address?: WithdrawAddressBody }
    | undefined;
  const pullId = body?.pull_id;
  if (typeof pullId !== 'string' || pullId.trim() === '') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      '`pull_id` (string) is required.',
    );
  }

  // Validate every field snapshotAddress requires is a non-empty string, then map
  // camelCase → the snake_case shape it consumes. A missing field is a bad request
  // here (recordRewardWithdrawal would otherwise reject it as 'invalid').
  const addr = body?.address;
  const fields = {
    first_name: addr?.firstName,
    last_name: addr?.lastName,
    address_1: addr?.address1,
    city: addr?.city,
    postal_code: addr?.postalCode,
    country_code: addr?.countryCode,
  };
  if (
    Object.values(fields).some((v) => typeof v !== 'string' || v.trim() === '')
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      '`address` requires firstName, lastName, address1, city, postalCode, and countryCode.',
    );
  }
  // MY-only shipping (2026-08-25) — same rule as the paid delivery flow.
  // Reward prizes stay fee-exempt, but the geographic gate is a shipping rule,
  // not a fee rule, so this path carries it too.
  if (!isMalaysianAddress(fields.country_code as string)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, MY_ONLY_MESSAGE);
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const result = await packs.recordRewardWithdrawal(
    customerId,
    pullId,
    fields as {
      first_name: string;
      last_name: string;
      address_1: string;
      city: string;
      postal_code: string;
      country_code: string;
    },
  );
  res.json(result);
}
