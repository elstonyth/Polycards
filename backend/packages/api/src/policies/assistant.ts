import { definePolicies } from '@medusajs/framework/utils';

// The in-admin AI assistant's own policies (spec 2026-10-29). Its routes get
// theirs from api/admin-rbac.ts (assistant, assistant_setting,
// assistant_review); these two guard what the assistant may do for someone,
// checked by its tool layer (api/admin/assistant/tools.ts), not by a route.
// Declared so the boot-time sync keeps them. Super admins (`*:*`) hold both.
export const assistantPolicies = definePolicies([
  {
    // Posters and AI-generated images: cost money per call, admins only
    // until the owner grants a growth role.
    name: 'Polycards create assistant_image',
    resource: 'assistant_image',
    operation: 'create',
    description: 'Make posters and AI images with the admin assistant.',
  },
  {
    // admin_read: any admin screen the asker's own roles open. Withheld from
    // the per-customer Support viewer (owner, 2026-10-29: one named customer
    // at a time), granted to the stock and order roles.
    name: 'Polycards read assistant_browse',
    resource: 'assistant_browse',
    operation: 'read',
    description: 'Let the admin assistant read admin screens for the asker.',
  },
]);
