import type {
  ExecArgs,
  IRbacModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';

// An admin login that sees and runs ONLY the Automation page (owner's request,
// 2026-10-23). The role holds the three `automation` policies and `store:read`,
// which the dashboard shell needs to draw its header (it throws on a 403 there).
// Every other admin route refuses it (api/admin-rbac.ts + core's own entries),
// and the sidebar hides every entry whose `permissions` it lacks.
export const AUTOMATION_OPERATOR_ROLE = 'Automation operator';
export const AUTOMATION_OPERATOR_POLICIES = [
  { resource: 'automation', operation: 'read' },
  { resource: 'automation', operation: 'update' },
  { resource: 'automation', operation: 'delete' },
  { resource: 'store', operation: 'read' },
] as const;

/** The operator role, created on first use and linked to the DECLARED policy
 *  rows. Never creates a policy: the boot sync soft-deletes undeclared ones
 *  (policies/desk-bots.ts), so a missing row means the code is out of date. */
export async function automationOperatorRoleId(
  scope: MedusaContainer,
): Promise<string> {
  const rbac = scope.resolve<IRbacModuleService>(Modules.RBAC);
  const policies = await Promise.all(
    AUTOMATION_OPERATOR_POLICIES.map(async ({ resource, operation }) => {
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
    { name: AUTOMATION_OPERATOR_ROLE },
    { order: { created_at: 'ASC' }, take: 1 },
  );
  const role =
    existing ??
    (await rbac.createRbacRoles({
      name: AUTOMATION_OPERATOR_ROLE,
      description: 'Sees and runs the admin Automation page, nothing else.',
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

/** Creates one admin user with the operator role and an email + password
 *  login, the way create-admin.ts creates the super admin. Refuses an email
 *  that already has an admin user: it never changes an existing login.
 *  Run: OPERATOR_EMAIL=… OPERATOR_PASSWORD=… medusa exec ./src/scripts/create-automation-operator.ts */
export async function createAutomationOperator(
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
  const roleId = await automationOperatorRoleId(scope);
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
  const email = process.env.OPERATOR_EMAIL?.trim().toLowerCase();
  const password = process.env.OPERATOR_PASSWORD;
  if (!email || !password) {
    throw new Error('Set OPERATOR_EMAIL and OPERATOR_PASSWORD.');
  }
  const userId = await createAutomationOperator(container, email, password);
  logger.info(
    `OPERATOR: created ${email} (user=${userId}) with role "${AUTOMATION_OPERATOR_ROLE}"`,
  );
}
