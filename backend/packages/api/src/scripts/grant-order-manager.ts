import type {
  ExecArgs,
  IRbacModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';

// Order handling for an EXISTING admin login (owner's request, 2026-10-27, for
// anson@polycards.gg, who already holds the Automation operator role). The
// role is added BESIDE the user's current ones, never in place of them.
// Covers every tab of the All Orders page (routes/deliveries): delivery
// orders to read and update (status, tracking, bulk marks), pack purchases
// (`pull:read`) and the proof photo upload (`media:update`, POST
// /admin/media). No `customer:read`: the player pages stay closed. No
// `payment:read` since 2026-10-28 (owner: "no money side") — it also opened
// the Payments section (withdrawals, deposits, reconciliation); the Orders
// page hides its Top-ups tab without it. No `customer_bank_account` /
// `partner_credential`.
export const ORDER_MANAGER_ROLE = 'Order manager';
export const ORDER_MANAGER_POLICIES = [
  { resource: 'delivery_order', operation: 'read' },
  { resource: 'delivery_order', operation: 'update' },
  { resource: 'pull', operation: 'read' },
  { resource: 'media', operation: 'update' },
] as const;

/** The role, created on first use and linked to the DECLARED policy rows.
 *  Never creates a policy: the boot sync soft-deletes undeclared ones
 *  (policies/desk-bots.ts), so a missing row means the code is out of date. */
export async function orderManagerRoleId(
  scope: MedusaContainer,
): Promise<string> {
  const rbac = scope.resolve<IRbacModuleService>(Modules.RBAC);
  const policies = await Promise.all(
    ORDER_MANAGER_POLICIES.map(async ({ resource, operation }) => {
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
    { name: ORDER_MANAGER_ROLE },
    { order: { created_at: 'ASC' }, take: 1 },
  );
  const role =
    existing ??
    (await rbac.createRbacRoles({
      name: ORDER_MANAGER_ROLE,
      description:
        'All Orders: read and update delivery orders, read pack purchases, upload proof photos.',
    }));
  for (const policy of policies) {
    const [link] = await rbac.listRbacRolePolicies(
      { role_id: role.id, policy_id: policy.id },
      { take: 1 },
    );
    if (!link) {
      await rbac.createRbacRolePolicies({
        role_id: role.id,
        policy_id: policy.id,
      });
    }
  }
  return role.id as string;
}

type AdminUser = { id: string; email: string; rbac_roles?: { id: string }[] };

/** Adds the Order manager role to one existing admin user via core's
 *  assign-user-roles workflow. That workflow checks the assigning actor holds
 *  every policy it hands out, so a super admin is the actor. Refuses an email
 *  with no admin user; a user who already has the role is left as is. */
export async function grantOrderManager(
  scope: MedusaContainer,
  email: string,
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
  if (!apply) {
    return `DRY RUN: would add "${ORDER_MANAGER_ROLE}" to ${email} (user=${user.id}, roles now: ${user.rbac_roles?.map((r) => r.id).join(',') || 'none'}). Pass "apply".`;
  }
  const roleId = await orderManagerRoleId(scope);
  if (user.rbac_roles?.some((r) => r.id === roleId)) {
    return `${email} already has "${ORDER_MANAGER_ROLE}" (${roleId}). Nothing changed.`;
  }
  await workflowService.run('assign-user-roles', {
    input: {
      user_id: user.id,
      role_ids: [roleId],
      actor_id: actor.id,
      actor: 'user',
    },
  });
  return `added "${ORDER_MANAGER_ROLE}" (${roleId}) to ${email} (user=${user.id})`;
}

/** Run: ORDER_MANAGER_EMAIL=… medusa exec ./src/scripts/grant-order-manager.ts [apply]
 *  Dry run unless the positional `apply` is given. */
export default async function run({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const email = process.env.ORDER_MANAGER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Set ORDER_MANAGER_EMAIL.');
  const result = await grantOrderManager(
    container,
    email,
    args?.includes('apply') ?? false,
  );
  logger.info(`ORDER_MANAGER: ${result}`);
}
