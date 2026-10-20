import type { MedusaContainer } from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { publicProfileFields, seedOf } from '../../../utils/profile-handle';

// shortcut: newest 100 only (the top referrer had 61 on 2026-10-19); page it
// if anyone outgrows that. downline_count stays uncapped, so the page can say
// how many it is not showing.
export const REFERRAL_FRIENDS_CAP = 100;

/**
 * The player's own direct referrals for GET /store/referral: newest first,
 * each with this settlement week's spend — the same per-member numbers the
 * admin referral card reads (#806), on the turnover rule the Tuesday close
 * pays on.
 *
 * 🔒 PII: the referrer sees public display fields only — the leaderboard's
 * name + handle (publicProfileFields). Never email, phone, last name or
 * customer id, all of which the admin card does show.
 */
export async function listReferralFriends(
  scope: MedusaContainer,
  input: { customerId: string; now: Date },
): Promise<
  {
    name: string;
    handle: string | null;
    joined_at: Date;
    week_spend_cents: number;
  }[]
> {
  const packs = scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customers = scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);

  const downline = await packs.listReferralAttributions(
    { referrer_id: input.customerId },
    { order: { created_at: 'DESC' }, take: REFERRAL_FRIENDS_CAP },
  );
  if (downline.length === 0) return [];

  const ids = downline.map((d) => d.customer_id);
  const [spend, people] = await Promise.all([
    packs.referralDownlineSpend({ customerIds: ids, now: input.now }),
    customers.listCustomers(
      { id: ids },
      { take: ids.length, select: ['id', 'first_name', 'metadata'] },
    ),
  ]);
  const personById = new Map(people.map((c) => [c.id, c]));

  // A deleted friend has no customer row: publicProfileFields falls back to
  // the anonymous "Collector ####" with no handle.
  return downline.map((d) => {
    const { name, handle } = publicProfileFields(
      personById.get(d.customer_id),
      seedOf(d.customer_id),
    );
    return {
      name,
      handle,
      joined_at: d.created_at,
      week_spend_cents: spend.get(d.customer_id)?.week_cents ?? 0,
    };
  });
}
