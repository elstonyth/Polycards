import type { ICustomerModuleService, CustomerDTO } from '@medusajs/types';

type CustomerFilters = Parameters<ICustomerModuleService['listCustomers']>[0];

/**
 * Resolves a customer by one metadata key. `metadata` is a JSONB column;
 * MikroORM translates the nested object into a JSON-path equality, but the
 * customer filter DTO doesn't declare metadata, hence the cast.
 */
async function findCustomerByMetadata(
  customers: ICustomerModuleService,
  key: string,
  value: string,
): Promise<CustomerDTO | null> {
  const matches = await customers.listCustomers(
    { metadata: { [key]: value } } as unknown as CustomerFilters,
    { take: 1 },
  );
  return matches[0] ?? null;
}

// There is no by-handle lookup here. The profile handle IS a metadata key
// (metadata.handle), but it must be matched case-insensitively against an
// expression index, which this file's exact JSON-path equality cannot do — see
// PacksModuleService.findCustomerIdByHandle.

/**
 * By referral code (metadata.referral_code — written by
 * PacksModuleService.assignReferralCode (modules/packs/service.ts)).
 * Exercised by referral.spec.ts.
 */
export async function findCustomerByReferralCode(
  customers: ICustomerModuleService,
  code: string,
): Promise<CustomerDTO | null> {
  return findCustomerByMetadata(customers, 'referral_code', code);
}
