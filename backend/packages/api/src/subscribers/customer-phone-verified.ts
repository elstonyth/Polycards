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
 * exists, and — critically — that middleware has already rejected any signup
 * whose body carried an UNPROVEN phone. So "the new customer has a phone"
 * implies "it was proven", but only for signups that happened while
 * PHONE_VERIFICATION_REQUIRED was on; hence the flag check below.
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
