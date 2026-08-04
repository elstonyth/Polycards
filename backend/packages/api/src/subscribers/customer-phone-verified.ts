import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { isPhoneVerificationRequired } from '../utils/phone-verification';

/**
 * Stamps `phone_verified_at` for a signup that carried a verified phone.
 *
 * Why a subscriber and not the signup middleware: requireSignupPhoneProof
 * (api/utils/phone-verification-guard.ts) runs BEFORE the customer row exists,
 * so it has a proof but no id to stamp. By the time this event fires the row
 * exists, and that middleware has already rejected any STOREFRONT signup whose
 * body carried an unproven phone.
 *
 * SCOPE, stated plainly because the event cannot tell us where it came from
 * (the payload is an id and nothing else): createCustomersWorkflow also backs
 * POST /admin/customers, so an operator who creates a customer WITH a phone
 * stamps them verified without an OTP. That is admin-authenticated and reads as
 * a deliberate vouch — an operator who types a number has usually just spoken to
 * the person — but it is a real way past the topup/delivery gate, and the next
 * reader should know it rather than infer an invariant that does not hold.
 *
 * The flag check below is what keeps this honest across the cutover: a phone
 * written while PHONE_VERIFICATION_REQUIRED was off was never proven by anyone.
 *
 * That flag check is the whole reason this cannot be inferred at read time
 * instead: a phone written before the flag flipped is indistinguishable in the
 * customer table from one written after, and treating it as verified would let
 * every pre-cutover account through the topup/delivery gates unverified.
 *
 * Google signups carry no phone and are correctly left unstamped — they verify
 * from account settings (store/phone-verification/change), which stamps too.
 *
 * Never throws: a missed stamp is fail-SAFE (the player is asked to verify,
 * which stamps them), where a rejection would retry-loop the event bus over an
 * account that already exists. Mirrors customer-default-group.ts.
 */
export default async function customerPhoneVerifiedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string } | { id: string }[]>) {
  if (!isPhoneVerificationRequired(process.env)) return;
  const logger = container.resolve('logger');
  // emitEventStep is handed an ARRAY by createCustomersWorkflow — same shape
  // handling (and same reason) as customer-default-group.ts.
  const ids = (Array.isArray(data) ? data : [data])
    .map((d) => d?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  if (ids.length === 0) return;

  try {
    const customers = container.resolve<ICustomerModuleService>(
      Modules.CUSTOMER,
    );
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const rows = await customers.listCustomers(
      { id: ids },
      { select: ['id', 'phone'], take: ids.length },
    );
    for (const c of rows) {
      if (typeof c.phone === 'string' && c.phone !== '') {
        await packs.markPhoneVerified(c.id);
      }
    }
  } catch (e) {
    logger.warn(
      `[customer-phone-verified] could not stamp ${ids.length} customer(s): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export const config: SubscriberConfig = {
  event: 'customer.created',
};
