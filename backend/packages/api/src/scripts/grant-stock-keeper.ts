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
// errors without it. 2026-10-28 owner, "full access on stock": also the
// PriceCharting import pages, Add stock and Import collection, which bring a
// new card into the catalog (`product` read + create — the pages sit under
// core's /products guard and save through POST /admin/products/
// from-pricecharting — plus `pricecharting:read`, `tcg:read` for card
// details, `pricing:read` for the FX rate the prices are shown in, and
// `media:update` for the image upload). Recording invoices shows purchase
// costs. Not included: "List to gacha card" (`card:update` also edits card
// prices on the Cards page, which moves the pack economy), changing the FX
// rate, players, wallets and payouts. A new role reaches the user at their
// next sign-in (role ids are copied into the login session); a policy added
// to a role they already hold applies on the next request.
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
  // Add stock / Import collection (PriceCharting import).
  { resource: 'product', operation: 'read' },
  { resource: 'product', operation: 'create' },
  { resource: 'pricecharting', operation: 'read' },
  { resource: 'tcg', operation: 'read' },
  { resource: 'pricing', operation: 'read' },
  { resource: 'media', operation: 'update' },
] as const;

const ALLOWED_KEYS = new Set(
  STOCK_KEEPER_POLICIES.map((p) => `${p.resource}:${p.operation}`),
);

/** The live "Stock keeper" role and the policy keys linked to it, or null.
 *  Read-only, so the dry run can show it. */
async function existingStockKeeper(
  scope: MedusaContainer,
): Promise<{ id: string; keys: string[] } | null> {
  const rbac = scope.resolve<IRbacModuleService>(Modules.RBAC);
  const [role] = await rbac.listRbacRoles(
    { name: STOCK_KEEPER_ROLE },
    { take: 1 },
  );
  if (!role) return null;
  const links = await rbac.listRbacRolePolicies(
    { role_id: role.id },
    { take: 500 },
  );
  const policies = links.length
    ? await rbac.listRbacPolicies(
        { id: links.map((l) => l.policy_id) },
        { take: links.length },
      )
    : [];
  return { id: role.id as string, keys: policies.map((p) => p.key).sort() };
}

/** The role, created on first use and linked to the DECLARED policy rows.
 *  Never creates a policy: the boot sync soft-deletes undeclared ones
 *  (policies/desk-bots.ts), so a missing row means the code is out of date.
 *  Refuses to reuse a same-named role that holds anything beyond the list —
 *  adding the role would hand the user those extras too. */
export async function stockKeeperRoleId(
  scope: MedusaContainer,
): Promise<{ id: string; created: boolean; added: number }> {
  const rbac = scope.resolve<IRbacModuleService>(Modules.RBAC);
  const found = await existingStockKeeper(scope);
  const extra = found?.keys.filter((k) => !ALLOWED_KEYS.has(k)) ?? [];
  if (extra.length) {
    throw new Error(
      `A "${STOCK_KEEPER_ROLE}" role (${found!.id}) already exists with policies outside this script's list: ${extra.join(', ')}. Nothing changed.`,
    );
  }
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
  const role =
    (found && { id: found.id }) ??
    (await rbac.createRbacRoles({
      name: STOCK_KEEPER_ROLE,
      description:
        'Stock: read the Stock list, read and record goods receive notes and purchase invoices, read the to-buy list, import new cards from PriceCharting.',
    }));
  let added = 0;
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
      added++;
    }
  }
  return { id: role.id as string, created: !found, added };
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
  const fields = ['id', 'email', 'rbac_roles.id'];
  // The target by email, case-insensitively ($ilike, then an exact
  // lower-case compare so a '_' or '%' in the address can't widen the match)
  // — never by scanning one page of every user.
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
    const found = await existingStockKeeper(scope);
    const role = found
      ? `existing role ${found.id} with ${found.keys.join(', ') || 'no policies'}`
      : 'a new role (none exists yet)';
    return `DRY RUN: would add "${STOCK_KEEPER_ROLE}" to ${email} (user=${user.id}, roles now: ${user.rbac_roles?.map((r) => r.id).join(',') || 'none'}) using ${role}. Pass "apply".`;
  }
  const { id: roleId, created, added } = await stockKeeperRoleId(scope);
  const roleNote = `${created ? 'created' : 'reused'} role ${roleId}, ${added} policy link(s) added`;
  if (user.rbac_roles?.some((r) => r.id === roleId)) {
    return `${email} already has "${STOCK_KEEPER_ROLE}" (${roleNote}).`;
  }
  await workflowService.run('assign-user-roles', {
    input: {
      user_id: user.id,
      role_ids: [roleId],
      actor_id: actor.id,
      actor: 'user',
    },
  });
  // Role ids are copied into the login session (generate-jwt-token +
  // check-permissions read app_metadata.roles), so the new role applies from
  // the user's next sign-in, not on reload.
  return `added "${STOCK_KEEPER_ROLE}" to ${email} (user=${user.id}; ${roleNote}). They must sign out and back in to get it.`;
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
