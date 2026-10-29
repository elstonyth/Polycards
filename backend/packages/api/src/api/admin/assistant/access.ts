import { hasPermission } from '@medusajs/framework';
import type { MedusaContainer } from '@medusajs/framework/types';

// Tools that save something that lasts. The engine runs them only before any
// tool output is in the turn (what was read may carry someone else's
// instructions), and a scheduled run, which nobody watches, never gets them.
export const LASTING_WRITES = new Set([
  'remember',
  'forget',
  'schedule_task',
  'cancel_schedule',
]);

// Who is asking, and what their admin roles let the assistant do for them
// (spec 2026-10-29: answers follow the asker's admin login, enforced here,
// never by the prompt). Roles come from the session, like every other admin
// route's RBAC check, so a role granted today applies after sign-out/in.

export type Need = { resource: string; operation: string } | 'super_admin';

export type Access = {
  userId: string;
  authIdentityId: string;
  roles: string[];
  superAdmin: boolean;
  can(need: Need): Promise<boolean>;
};

type AuthContext = {
  actor_id: string;
  auth_identity_id?: string;
  app_metadata?: Record<string, unknown>;
};

// Every staff login holds this role (`*:*`). A literal check: hasPermission
// answers TRUE for an empty role list, so it never decides super admin.
export const SUPER_ADMIN_ROLE = 'role_super_admin';

export function accessFor(
  container: MedusaContainer,
  auth: AuthContext,
): Access {
  const raw = auth.app_metadata?.roles;
  const roles = Array.isArray(raw)
    ? raw.filter((r): r is string => typeof r === 'string' && r !== '')
    : [];
  const superAdmin = roles.includes(SUPER_ADMIN_ROLE);
  const seen = new Map<string, Promise<boolean>>();
  return {
    userId: auth.actor_id,
    authIdentityId: auth.auth_identity_id ?? '',
    roles,
    superAdmin,
    can(need) {
      if (need === 'super_admin') return Promise.resolve(superAdmin);
      // No roles = no access, whatever hasPermission([]) would say.
      if (!roles.length) return Promise.resolve(false);
      const key = `${need.resource}:${need.operation}`;
      let answer = seen.get(key);
      if (!answer) {
        answer = hasPermission({ roles, actions: need, container }).catch(
          () => false,
        );
        seen.set(key, answer);
      }
      return answer;
    },
  };
}

/** The tools whose every need the asker meets, in catalog order. A tool
 *  that names no need is offered to nobody ([].every() would say yes). */
export async function allowedTools<T extends { needs: Need[] }>(
  access: Access,
  catalog: readonly T[],
): Promise<T[]> {
  const ok = await Promise.all(
    catalog.map(
      async (tool) =>
        tool.needs.length > 0 &&
        (await Promise.all(tool.needs.map((n) => access.can(n)))).every(
          Boolean,
        ),
    ),
  );
  return catalog.filter((_, i) => ok[i]);
}
