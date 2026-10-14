import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { resolveFxRateStrict } from '../../../../modules/packs/pricing';
import {
  isShippableCountry,
  isShippablePostcode,
  SHIPPING_COUNTRIES_MESSAGE,
  postcodeMessage,
} from '../../../../modules/packs/delivery';

// POST /store/rewards/withdraw — ship a vaulted reward-prize Pull as a physical
// delivery. Body: { pull_id, address: { firstName, lastName, address1, city,
// postalCode, countryCode } } — a free-form address the customer types for THIS
// shipment (not a saved-address id). This is the simpler, correct UX: the prize
// is already theirs, so the address is just where they want it sent.
//
// NOT ENV-GATED (2026-10-08). This route used to 403 while
// REWARDS_REDEMPTION_ENABLED was off, on the premise that no legitimate prize
// could exist before the VIP economy launched. That stopped being true when
// /task claims, free rips and weekly-challenge prizes began minting
// source='reward' pulls (#490 onward): every one of those cards was stuck in
// the vault, and customers saw "Something went wrong" on Request delivery.
// Shipping mints no value — it only moves a card the customer already owns —
// so the gate stays on claim (which does mint) and comes off here. The
// per-customer withdrawals_per_day cap in recordRewardWithdrawal still applies.
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
  address2?: unknown;
  province?: unknown;
  phone?: unknown;
};

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
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
  // Malaysia and Singapore only, with a postcode we can zone — the same rules
  // as the paid delivery flow. Since 2026-10-14 a prize pays its zone's
  // shipping too (recordRewardWithdrawal), so the zone must be priceable.
  if (!isShippableCountry(fields.country_code as string)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, SHIPPING_COUNTRIES_MESSAGE);
  }
  if (
    !isShippablePostcode(
      fields.postal_code as string,
      fields.country_code as string,
    )
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      postcodeMessage(fields.country_code as string),
    );
  }

  // Optional lines of the saved address. The paid path snapshots them from the
  // address book; without them a reward shipment reached ops with no phone for
  // the courier and no second address line.
  const optional = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // Resolved before the transaction, as the paid path does: it values the
  // prize for its mandatory insurance. STRICT — a real wallet debit is never
  // priced on a cached/fallback rate.
  const fx = await resolveFxRateStrict(packs);
  const result = await packs.recordRewardWithdrawal(
    customerId,
    pullId,
    {
    ...(fields as {
      first_name: string;
      last_name: string;
      address_1: string;
      city: string;
      postal_code: string;
      country_code: string;
    }),
    address_2: optional(addr?.address2),
    province: optional(addr?.province),
    phone: optional(addr?.phone),
    },
    fx,
  );
  res.json(result);
}

// GET /store/rewards/withdraw — how many prize cards the customer can still
// ship today (withdrawals_per_day less today's prize shipments), so the
// delivery sheet prices and sends only those. Auth + rate limit come from the
// '/store/rewards/*' wildcard in api/middlewares.ts.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const allowance = await packs.rewardShippingAllowance(customerId);
  res.json({
    per_day: allowance.perDay,
    used_today: allowance.usedToday,
    remaining: allowance.remaining,
  });
}
