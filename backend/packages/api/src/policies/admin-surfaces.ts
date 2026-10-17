import { definePolicies } from '@medusajs/framework/utils';
import { CUSTOM_ADMIN_RESOURCES, OPERATION_BY_METHOD } from '../api/admin-rbac';

// The custom admin surfaces' policies (see api/admin-rbac.ts). Declared so the
// boot-time sync keeps them (it soft-deletes every undeclared policy) and so a
// future limited role can be granted them; the roles in use today hold `*:*`
// or `*:read` and pass without them. Names carry a Polycards prefix because
// definePolicies registers them in a process-wide map keyed by name.
export const adminSurfacePolicies = definePolicies(
  Object.values(CUSTOM_ADMIN_RESOURCES).flatMap((resource) =>
    [...new Set(Object.values(OPERATION_BY_METHOD))].map((operation) => ({
      name: `Polycards ${operation} ${resource}`,
      resource,
      operation,
      description: `${operation} on the Polycards admin ${resource} screens.`,
    })),
  ),
);
