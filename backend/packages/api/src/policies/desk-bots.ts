import { definePolicies } from '@medusajs/framework/utils';

// The desk bots' read-only admin proxy (api/reports/admin/proxy.ts) gives its
// tokens one role whose only policy is read on every resource (`*:read`).
//
// It must be declared here. On every boot the RBAC module syncs its policy
// table against the policies declared with definePolicies and SOFT-DELETES
// every other one (RbacModuleService.syncRegisteredPolicies; only `*:*` is
// spared). An undeclared `*:read`, created at run time, lived 17 minutes in
// production on 2026-10-04 before the next deploy deleted it, and every
// admin screen then refused the bots ("Required policies: customer:read").
// Declared, the sync keeps it, and restores it if it was deleted.
export const deskBotPolicies = definePolicies({
  name: 'DeskBotsReadEverything',
  resource: '*',
  operation: 'read',
  description:
    'Read on every resource, nothing else: the staff Discord desk bots.',
});
