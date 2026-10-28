import type {
  ExecArgs,
  IRbacModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';

// Stock work for an EXISTING admin login (owner's request, 2026-10-28, for
// anson@polycards.gg, who already holds Automation operator + Order manager).
// The role is added BESIDE the user's current ones, never in place of them.
// "View and record": the Stock list and item pages (`inventory:read`), goods
// receive notes and purchase invoices to read and create
// (`goods_receive_note`, `purchase_invoice` read + update — update covers a
// GRN reversal and a transfer into an invoice), and the Procurement to-buy
// list (`procurement:read`; the to-ship list also needs `delivery_order:read`,
// which the Order manager role carries). `store:read` because the admin shell
// errors without it. Not included: "List to gacha card" on the Stock list
// (`gacha`, `card`), the PriceCharting import pages (`pricecharting`), and
// anything about players or money.
export const STOCK_KEEPER_ROLE = 'Stock keeper';
export const STOCK_KEEPER_POLICIES = [
  { resource: 'store', operation: 'read' },
  { resource: 'inventory', operation: 'read' },
  // The admin's own route guard on /inventory/* (the Stock list lives under
  // it) asks core's inventory_item:read; read-only.
  { resource: 'inventory_item', operation: 'read' },
  { resource: 'goods_receive_note', operation: 'read' },
  { resource: 'goods_receive_note', operation: 'update' },
  { resource: 'purchase_invoice', operation: 'read' },
  { resource: 'purchase_invoice', operation: 'update' },
  { resource: 'procurement', operation: 'read' },
] as const;

/** The role, created on first use and linked to the DECLARED policy rows.
 *  Never creates a policy: the boot sync soft-deletes undeclared ones
 *  (policies/desk-bots.ts), so a missing row means the code is out of date. */
export async function stockKeeperRoleId(
  scope: MedusaContainer,
): Promise<string> {
  const rbac = scope.resolve<IRbacModuleService>(Modules.RBAC);
  const policies = await Promise.all(
    STOCK_KEEPER_POLICIES.map(async ({ resource, operation }) => {
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
    { name: STOCK_KEEPER_ROLE },
    { order: { created_at: 'ASC' }, take: 1 },
  );
  const role =
    existing ??
    (await rbac.createRbacRoles({
      name: STOCK_KEEPER_ROLE,
      description:
        'Stock: read the Stock list, read and record goods receive notes and purchase invoices, read the to-buy list.',
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

/** Adds the Stock keeper role to one existing admin user via core's
 *  assign-user-roles workflow. That workflow checks the assigning actor holds
 *  every policy it hands out, so a super admin is the actor. Refuses an email
 *  with no admin user; a user who already has the role is left as is. */
export async function grantStockKeeper(
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
    return `DRY RUN: would add "${STOCK_KEEPER_ROLE}" to ${email} (user=${user.id}, roles now: ${user.rbac_roles?.map((r) => r.id).join(',') || 'none'}). Pass "apply".`;
  }
  const roleId = await stockKeeperRoleId(scope);
  if (user.rbac_roles?.some((r) => r.id === roleId)) {
    return `${email} already has "${STOCK_KEEPER_ROLE}" (${roleId}); its policy links were checked and any missing one added.`;
  }
  await workflowService.run('assign-user-roles', {
    input: {
      user_id: user.id,
      role_ids: [roleId],
      actor_id: actor.id,
      actor: 'user',
    },
  });
  return `added "${STOCK_KEEPER_ROLE}" (${roleId}) to ${email} (user=${user.id})`;
}

/** Run: STOCK_KEEPER_EMAIL=… medusa exec ./src/scripts/grant-stock-keeper.ts [apply]
 *  Dry run unless the positional `apply` is given. */
export default async function run({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const email = process.env.STOCK_KEEPER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Set STOCK_KEEPER_EMAIL.');
  const result = await grantStockKeeper(
    container,
    email,
    args?.includes('apply') ?? false,
  );
  logger.info(`STOCK_KEEPER: ${result}`);
}
