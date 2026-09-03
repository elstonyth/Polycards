import type { ICustomerModuleService, CustomerDTO } from "@medusajs/types";

type CustomerFilters = Parameters<ICustomerModuleService["listCustomers"]>[0];

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

/**
 * By public profile handle (metadata.handle — written by the
 * ensure-profile-handle workflow and the seed script). Exercised by
 * public-profile.spec.ts.
 */
export async function findCustomerByHandle(
  customers: ICustomerModuleService,
  handle: string,
): Promise<CustomerDTO | null> {
  return findCustomerByMetadata(customers, "handle", handle);
}

/**
 * By referral code (metadata.referral_code — written by ensureReferralCode,
 * utils/referral-code.ts). Exercised by referral.spec.ts.
 */
export async function findCustomerByReferralCode(
  customers: ICustomerModuleService,
  code: string,
): Promise<CustomerDTO | null> {
  return findCustomerByMetadata(customers, "referral_code", code);
}
