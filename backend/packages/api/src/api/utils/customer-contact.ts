import type { ICustomerModuleService } from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';
import type { TgpayCustomer } from '../../modules/packs/tgpay-client';

/**
 * The name/email/phone TGPay requires on every create-payment and payout.
 * Read from the customer record, never from the request body. A customer
 * without a phone (Google sign-in) gets a placeholder — the gateway wants
 * the field present; it is not what the money is routed by.
 */
export async function customerContact(
  scope: { resolve: <T>(key: string) => T },
  customerId: string,
): Promise<TgpayCustomer> {
  const customers = scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const c = await customers.retrieveCustomer(customerId, {
    select: ['email', 'first_name', 'last_name', 'phone'],
  });
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return {
    name: name || c.email?.split('@')[0] || 'Customer',
    email: c.email ?? '',
    phoneNumber: (c.phone ?? '').replace(/[^\d+]/g, '') || '0000000000',
  };
}
