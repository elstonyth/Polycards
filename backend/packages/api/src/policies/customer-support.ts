import { definePolicies } from '@medusajs/framework/utils';
import { CUSTOMER_SUPPORT_WRITE } from '../api/admin-rbac';

// The customer-service fixes without the rest of customer:update (owner,
// 2026-11-19): correct a real name, add, remove or verify a saved bank
// account (api/admin-rbac.ts CUSTOMER_SUPPORT_WRITE). Declared so the
// boot-time sync keeps it; held by super admins (`*:*`) and the Customer
// support role (scripts/create-support-viewer.ts).
export const customerSupportPolicies = definePolicies([
  {
    name: 'Polycards update customer_support',
    resource: CUSTOMER_SUPPORT_WRITE.resource,
    operation: CUSTOMER_SUPPORT_WRITE.operation,
    description:
      "Correct a customer's real name and add, remove or verify their saved bank accounts.",
  },
]);
