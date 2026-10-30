import type {
  ExecArgs,
  IRbacModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';

// The admin AI assistant for an EXISTING limited admin login (spec
// 2026-10-29). Super admins (`*:*`) need nothing. Roles are added BESIDE the
// user's current ones, never in place of them, so what the assistant can
// answer for them still follows their other roles:
//  - "AI assistant": open the chat, keep and delete their own chats.
//  - "AI assistant browse" (only with ASSISTANT_BROWSE=1): admin_read, the
//    assistant reading admin screens AS them (their own RBAC still applies).
//    Given to the stock and order roles (anson@polycards.gg), withheld from
//    the per-customer Support viewer (yu@polycards.gg), owner 2026-10-29.
// A new role only applies after the user signs out and in (the roles are
// copied into the login session).

type RoleSpec = {
  name: string;
  description: string;
  policies: { resource: string; operation: string }[];
};

export const ASSISTANT_ROLE: RoleSpec = {
  name: 'AI assistant',
  description: 'Use the admin AI assistant: ask, keep and delete own chats.',
  policies: [
    { resource: 'assistant', operation: 'read' },
    { resource: 'assistant', operation: 'update' },
    { resource: 'assistant', operation: 'delete' },
  ],
};

export const ASSISTANT_BROWSE_ROLE: RoleSpec = {
  name: 'AI assistant browse',
  description:
    'Let the admin AI assistant read admin screens for this user (their own permissions still apply).',
  policies: [{ resource: 'assistant_browse', operation: 'read' }],
};

/** The roles a user gets: the chat always, admin screens only with browse. */
export const assistantRolesFor = (browse: boolean): RoleSpec[] =>
  browse ? [ASSISTANT_ROLE, ASSISTANT_BROWSE_ROLE] : [ASSISTANT_ROLE];

/** The role, created on first use and linked to the DECLARED policy rows.
 *  Never creates a policy: the boot sync soft-deletes undeclared ones, so a
 *  missing row means the deployed code is older than this script. */
async function ensureRole(
  scope: MedusaContainer,
  spec: RoleSpec,
): Promise<string> {
  const rbac = scope.resolve<IRbacModuleService>(Modules.RBAC);
  const policies = await Promise.all(
    spec.policies.map(async ({ resource, operation }) => {
      const [policy] = await rbac.listRbacPolicies(
        { resource, operation },
        { take: 1 },
      );
      if (!policy) {
        throw new Error(`No live RBAC policy ${resource}:${operation}.`);
      }
      return policy;
    }),
  );
  const [existing] = await rbac.listRbacRoles(
    { name: spec.name },
    { order: { created_at: 'ASC' }, take: 1 },
  );
  const links = existing
    ? await rbac.listRbacRolePolicies({ role_id: existing.id })
    : [];
  // A same-named role holding more than the spec would hand that out too.
  const wanted = new Set(policies.map((p) => p.id));
  const foreign = links.filter((l) => !wanted.has(l.policy_id));
  if (foreign.length) {
    throw new Error(
      `Role "${spec.name}" (${existing?.id}) also holds policies outside the assistant's: ${foreign.map((l) => l.policy_id).join(', ')}. Rename or trim that role first.`,
    );
  }
  const role =
    existing ??
    (await rbac.createRbacRoles({
      name: spec.name,
      description: spec.description,
    }));
  const held = new Set(links.map((l) => l.policy_id));
  for (const policy of policies) {
    if (held.has(policy.id)) continue;
    await rbac.createRbacRolePolicies({
      role_id: role.id,
      policy_id: policy.id,
    });
  }
  return role.id as string;
}

type AdminUser = { id: string; email: string; rbac_roles?: { id: string }[] };

/** Adds the assistant role(s) to one existing admin user via core's
 *  assign-user-roles workflow, with a super admin as the assigning actor.
 *  Refuses an email with no admin user. Dry run unless `apply`. */
export async function grantAssistant(
  scope: MedusaContainer,
  email: string,
  browse: boolean,
  apply: boolean,
): Promise<string> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workflowService: any = scope.resolve(Modules.WORKFLOW_ENGINE);
  const { data } = await query.graph({
    entity: 'user',
    fields: ['id', 'email', 'rbac_roles.id'],
  });
  const users = data as AdminUser[];
  const user = users.find((u) => u.email === email);
  if (!user) throw new Error(`${email} has no admin user. Nothing changed.`);
  const actor = users.find((u) =>
    u.rbac_roles?.some((r) => r.id === 'role_super_admin'),
  );
  if (!actor) throw new Error('No super admin user to assign as.');
  const specs = assistantRolesFor(browse);
  if (!apply) {
    return `DRY RUN: would add ${specs.map((s) => `"${s.name}"`).join(' + ')} to ${email} (user=${user.id}, roles now: ${user.rbac_roles?.map((r) => r.id).join(',') || 'none'}). Pass "apply".`;
  }
  // Every role checked before any is assigned: a refusal leaves no half grant.
  const roles: { spec: RoleSpec; roleId: string }[] = [];
  for (const spec of specs) {
    roles.push({ spec, roleId: await ensureRole(scope, spec) });
  }
  const added: string[] = [];
  for (const { spec, roleId } of roles) {
    if (user.rbac_roles?.some((r) => r.id === roleId)) continue;
    await workflowService.run('assign-user-roles', {
      input: {
        user_id: user.id,
        role_ids: [roleId],
        actor_id: actor.id,
        actor: 'user',
      },
    });
    added.push(`"${spec.name}" (${roleId})`);
  }
  return added.length
    ? `added ${added.join(' + ')} to ${email} (user=${user.id}); they must sign out and in`
    : `${email} already has every assistant role asked for. Nothing changed.`;
}

/** Run: ASSISTANT_EMAIL=… [ASSISTANT_BROWSE=1] medusa exec ./src/scripts/grant-assistant.ts [apply] */
export default async function run({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const email = process.env.ASSISTANT_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Set ASSISTANT_EMAIL.');
  const result = await grantAssistant(
    container,
    email,
    process.env.ASSISTANT_BROWSE === '1',
    args?.includes('apply') ?? false,
  );
  logger.info(`ASSISTANT: ${result}`);
}
