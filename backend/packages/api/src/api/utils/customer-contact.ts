import type { ICustomerModuleService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { GATEWAYS, type PaymentGateway } from '../../modules/packs/gateway';
import type { TgpayCustomer } from '../../modules/packs/tgpay-client';

/**
 * The name/email/phone TGPay requires on a create-payment (and the email
 * its payouts need), read from the customer record — never from the request
 * body — and only when the active gateway asks for it: GlobePay does not,
 * and its route tests run with a scope that has no customer module.
 *
 * A payment for a customer without a phone is refused rather than given a
 * made-up one: the money routes carry a phone-verification gate in
 * production, so this only fires where that gate is off, and a fabricated
 * number sent to a payment provider is a compliance problem, not a
 * convenience. Payouts need no phone, so they are not held to it.
 */
export async function contactIfNeeded(
  scope: { resolve: <T>(key: string) => T },
  gateway: PaymentGateway,
  customerId: string,
  purpose: 'payment' | 'payout',
): Promise<TgpayCustomer | undefined> {
  if (!GATEWAYS[gateway].needsCustomerContact) return undefined;
  const customers = scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const c = await customers.retrieveCustomer(customerId, {
    select: ['email', 'first_name', 'last_name', 'phone'],
  });
  return contactFromRecord(c, purpose);
}

/** Pure half, for tests: the record → what the gateway is sent. */
export function contactFromRecord(
  c: {
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
  },
  purpose: 'payment' | 'payout',
): TgpayCustomer {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  const phoneNumber = (c.phone ?? '').replace(/[^\d+]/g, '');
  if (purpose === 'payment' && !phoneNumber) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Verify your phone number in Account settings before continuing.',
    );
  }
  return {
    name: name || c.email?.split('@')[0] || 'Customer',
    email: c.email ?? '',
    phoneNumber,
  };
}
