import type {
  ExecArgs,
  IRbacModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';

// A VIEW-ONLY support login (owner's request, 2026-10-26, for yu@polycards.gg):
// search players and read everything support needs to answer a customer —
// profile, wallet ledger, vault, pulls, delivery orders, gifts, and every
// gateway top-up / withdrawal with its status (player page → Payments tab) —
// and change nothing. Read policies only: every write route asks for
// `update`/`create`/`delete` (api/admin-rbac.ts + core's own entries), so the
// API refuses any edit even if a button is clicked. `store:read` is for the
// dashboard shell (its header throws on a 403 there). No `stats:read`: the
// dashboard's money figures stay with staff; the role lands on Players.
export const SUPPORT_VIEWER_ROLE = 'Support viewer';
export const SUPPORT_VIEWER_POLICIES = [
  'store',
  'customer',
  'player',
  'payment',
  'delivery_order',
  'ledger',
  'pull',
  'pack_gift',
  'lucky_draw',
].map((resource) => ({ resource, operation: 'read' as const }));

/** The role, created on first use and linked to the DECLARED policy rows.
 *  Never creates a policy: the boot sync soft-deletes undeclared ones
 *  (policies/desk-bots.ts), so a missing row means the code is out of date. */
export async function supportViewerRoleId(
  scope: MedusaContainer,
): Promise<string> {
  const rbac = scope.resolve<IRbacModuleService>(Modules.RBAC);
  const policies = await Promise.all(
    SUPPORT_VIEWER_POLICIES.map(async ({ resource, operation }) => {
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
    { name: SUPPORT_VIEWER_ROLE },
    { order: { created_at: 'ASC' }, take: 1 },
  );
  const role =
    existing ??
    (await rbac.createRbacRoles({
      name: SUPPORT_VIEWER_ROLE,
      description:
        'View-only support: players, payments, orders. Cannot change anything.',
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

/** Creates one admin user with the Support viewer role and an email +
 *  password login (create-automation-operator.ts's flow). Refuses an email
 *  that already has an admin user: it never changes an existing login.
 *  Run: VIEWER_EMAIL=… VIEWER_PASSWORD=… medusa exec ./src/scripts/create-support-viewer.ts */
export async function createSupportViewer(
  scope: MedusaContainer,
  email: string,
  password: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userModule: any = scope.resolve(Modules.USER);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authService: any = scope.resolve(Modules.AUTH);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workflowService: any = scope.resolve(Modules.WORKFLOW_ENGINE);

  if ((await userModule.listUsers({ email })).length) {
    throw new Error(`${email} already has an admin user. Nothing changed.`);
  }
  const roleId = await supportViewerRoleId(scope);
  const { result: users } = await workflowService.run('create-users-workflow', {
    input: { users: [{ email, roles: [roleId] }] },
  });
  const user = users[0];
  const { authIdentity, error } = await authService.register('emailpass', {
    body: { email, password },
  });
  if (error || !authIdentity) {
    throw new Error(`emailpass register failed for ${email}: ${error}`);
  }
  await authService.updateAuthIdentities({
    id: authIdentity.id,
    app_metadata: { user_id: user.id },
  });
  return user.id as string;
}

export default async function run({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const email = process.env.VIEWER_EMAIL?.trim().toLowerCase();
  const password = process.env.VIEWER_PASSWORD;
  if (!email || !password) {
    throw new Error('Set VIEWER_EMAIL and VIEWER_PASSWORD.');
  }
  const userId = await createSupportViewer(container, email, password);
  logger.info(
    `VIEWER: created ${email} (user=${userId}) with role "${SUPPORT_VIEWER_ROLE}"`,
  );
}
