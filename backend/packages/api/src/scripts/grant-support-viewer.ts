import type { ExecArgs, MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import {
  SUPPORT_VIEWER_ROLE,
  supportViewerRoleId,
} from './create-support-viewer';

// The view-only Support viewer role for an EXISTING admin login (owner's
// request, 2026-10-31, for anson@polycards.gg: "see the players same like Yu").
// create-support-viewer.ts refuses an existing login, so this adds the same
// shared role BESIDE the user's current ones: a later change to the role
// reaches everyone holding it. It carries `payment:read`, which opens the
// Payments section read-only. `customer:read` no longer opens the Automation
// account list (api/admin-rbac.ts asks `customer:update`), so an automation
// operator holding this role still runs only the accounts staff chose.

type AdminUser = { id: string; email: string; rbac_roles?: { id: string }[] };

/** Adds the Support viewer role to one existing admin user via core's
 *  assign-user-roles workflow. That workflow checks the assigning actor holds
 *  every policy it hands out, so a super admin is the actor. Refuses an email
 *  with no admin user; a user who already has the role is left as is. */
export async function grantSupportViewer(
  scope: MedusaContainer,
  email: string,
  apply: boolean,
): Promise<string> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workflowService: any = scope.resolve(Modules.WORKFLOW_ENGINE);
  const fields = ['id', 'email', 'rbac_roles.id'];
  // The target by email, case-insensitively ($ilike, then an exact
  // lower-case compare so a '_' or '%' in the address can't widen the match).
  const { data: matches } = await query.graph({
    entity: 'user',
    fields,
    filters: { email: { $ilike: email } },
  });
  const same = (matches as AdminUser[]).filter(
    (u) => u.email.toLowerCase() === email,
  );
  if (same.length > 1) {
    throw new Error(
      `${same.length} admin users match ${email} ignoring case: ${same.map((u) => u.email).join(', ')}. Nothing changed.`,
    );
  }
  const [user] = same;
  if (!user) throw new Error(`${email} has no admin user. Nothing changed.`);
  const { data } = await query.graph({ entity: 'user', fields });
  const actor = (data as AdminUser[]).find((u) =>
    u.rbac_roles?.some((r) => r.id === 'role_super_admin'),
  );
  if (!actor) throw new Error('No super admin user to assign as.');
  if (!apply) {
    return `DRY RUN: would add "${SUPPORT_VIEWER_ROLE}" to ${email} (user=${user.id}, roles now: ${user.rbac_roles?.map((r) => r.id).join(',') || 'none'}). Pass "apply".`;
  }
  const roleId = await supportViewerRoleId(scope);
  if (user.rbac_roles?.some((r) => r.id === roleId)) {
    return `${email} already has "${SUPPORT_VIEWER_ROLE}" (${roleId}). Nothing changed.`;
  }
  await workflowService.run('assign-user-roles', {
    input: {
      user_id: user.id,
      role_ids: [roleId],
      actor_id: actor.id,
      actor: 'user',
    },
  });
  // Role ids are copied into the login session, so the new role applies from
  // the user's next sign-in, not on reload.
  return `added "${SUPPORT_VIEWER_ROLE}" (${roleId}) to ${email} (user=${user.id}). They must sign out and back in to get it.`;
}

/** Run: SUPPORT_VIEWER_EMAIL=… medusa exec ./src/scripts/grant-support-viewer.ts [apply]
 *  Dry run unless the positional `apply` is given. */
export default async function run({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const email = process.env.SUPPORT_VIEWER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Set SUPPORT_VIEWER_EMAIL.');
  const result = await grantSupportViewer(
    container,
    email,
    args?.includes('apply') ?? false,
  );
  logger.info(`SUPPORT_VIEWER: ${result}`);
}
