import { z } from './zod';
import { finite } from './shared';

/** A VIP voucher/frame grant row (GET /store/daily `vouchers.claimable|claimed`
 *  and the pre-consolidation GET /store/rewards `grants`). `status` is optional:
 *  the daily-state grant rows (packs/service.ts `GrantView`) never carry it —
 *  only the legacy rewards envelope did. `level` is a required top-level field:
 *  `GrantView` (packs/service.ts:199-205) declares `level: number`, and
 *  `toGrantView` (packs/service.ts:3223-3229) always sources it from the
 *  `VipRewardGrant.level` column (`model.number()`, non-nullable). `kind` and
 *  `origin` still admit 'box': the daily box is gone, but historical grant rows
 *  that carry it must keep parsing. */
export const RewardGrantSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['voucher', 'frame', 'box', 'prize']),
  status: z.enum(['granted', 'fulfilled', 'revoked']).optional(),
  level: finite,
  origin: z.enum(['ladder', 'box']).optional(),
  payload: z.looseObject({}).nullable().optional(),
  granted_at: z.string(),
});

/** Address input for prize withdrawal (subset of AddAddressInput). Defined here
 *  because this module is the app's sole `zod` importer (eslint no-restricted-imports). */
export const WithdrawAddressSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  address1: z.string().min(1),
  city: z.string().min(1),
  postalCode: z.string().min(1),
  countryCode: z.string().min(2).max(2),
  // Optional, but the courier needs the phone: the vault sends them from the
  // saved address so a reward shipment carries what a paid one does.
  address2: z.string().nullish(),
  province: z.string().nullish(),
  phone: z.string().nullish(),
});
export type WithdrawAddressInput = z.infer<typeof WithdrawAddressSchema>;

/** POST /store/rewards/claim/:grantId response. */
export const ClaimGrantSchema = z.looseObject({
  claimed: z.boolean(),
  kind: z.string(),
});

/** POST /store/rewards/withdraw response. */
export const WithdrawPrizeSchema = z.looseObject({
  status: z.enum(['requested', 'capped', 'invalid']),
});

/** GET /store/rewards/withdraw — today's prize-shipping allowance. */
export const PrizeAllowanceSchema = z.looseObject({
  per_day: finite,
  used_today: finite,
  remaining: finite,
});

/** GET /store/daily — the VIP voucher/frame grant state (packs/service.ts
 *  `DailyState`). The box and ship-prize halves went with the daily box
 *  (2026-08-25). */
export const DailyStateSchema = z.looseObject({
  redemption_enabled: z.boolean(),
  vouchers: z.looseObject({
    claimable: z.array(RewardGrantSchema),
    claimed: z.array(RewardGrantSchema),
  }),
});
