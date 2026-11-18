import { hasPermission } from '@medusajs/framework';
import type { MedusaContainer } from '@medusajs/framework/types';
import { CORE_READ_PREFIXES, CUSTOM_ADMIN_RESOURCES } from '../../admin-rbac';

/** What running a tool does, declared on each tool. */
export type Effect =
  /** Leaves no lasting state the model sees in later chats or runs, so it
   *  may run with nobody watching. Not side-effect free: the image tools
   *  store a file and spend image-model credit. */
  | 'read'
  /** Saves or deletes something that lasts (a note, a scheduled task). The
   *  engine runs it only before any tool output is in the turn: what was
   *  read may carry someone else's instructions. */
  | 'lasting_write'
  /** Proposes a ban or bank-number change, applied only on a tap
   *  (confirm.ts). */
  | 'ban_change';

/** One assistant tool, whatever its context (tools.ts, agent-tools.ts). */
export type Tool<Ctx> = {
  name: string;
  /** A short label for the chat's step timeline. */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  needs: Need[];
  effect: Effect;
  run(args: Record<string, unknown>, ctx: Ctx): Promise<string>;
};

/** A scheduled run has nobody watching and nobody to tap: read tools only,
 *  no lasting writes and no ban changes. */
export const scheduledRunAllows = (t: { effect: Effect }): boolean =>
  t.effect === 'read';

const SCREEN_RESOURCES = { ...CUSTOM_ADMIN_RESOURCES, ...CORE_READ_PREFIXES };

/** Reading what the admin screen /admin/<prefix> shows: that screen's own
 *  policy (admin-rbac.ts). The desk reports the tools call do no per-user
 *  RBAC (bridge.ts), so this is their only gate. */
export const screen = (prefix: keyof typeof SCREEN_RESOURCES): Need => ({
  resource: SCREEN_RESOURCES[prefix],
  operation: 'read',
});

/** Posters and AI images (policies/assistant.ts). */
export const IMAGES: Need = { resource: 'assistant_image', operation: 'create' };

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
