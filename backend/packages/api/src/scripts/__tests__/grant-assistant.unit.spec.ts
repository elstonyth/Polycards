import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { assistantPolicies } from '../../policies/assistant';
import { adminSurfacePolicies } from '../../policies/admin-surfaces';
import { assistantRolesFor, grantAssistant } from '../grant-assistant';

const declared = new Set(
  [...assistantPolicies.policies, ...adminSurfacePolicies.policies].map(
    (p) => `${p.resource}:${p.operation}`,
  ),
);
const keys = (browse: boolean) =>
  assistantRolesFor(browse).flatMap((r) =>
    r.policies.map((p) => `${p.resource}:${p.operation}`),
  );

describe('grant-assistant roles', () => {
  it('gives a per-customer role the chat only, never admin screens', () => {
    expect(keys(false)).toEqual([
      'assistant:read',
      'assistant:update',
      'assistant:delete',
    ]);
  });

  it('adds admin-screen reading only when browse is asked for', () => {
    expect(keys(true)).toEqual([
      'assistant:read',
      'assistant:update',
      'assistant:delete',
      'assistant_browse:read',
    ]);
  });

  it('links only declared policies (the boot sync deletes the rest)', () => {
    for (const key of keys(true)) expect(declared).toContain(key);
  });
});

type Role = { id: string; name: string };
type Link = { role_id: string; policy_id: string };

const OWNER = {
  id: 'user_owner',
  email: 'owner@polycards.gg',
  rbac_roles: [{ id: 'role_super_admin' }],
};
const ANSON = {
  id: 'user_anson',
  email: 'anson@polycards.gg',
  rbac_roles: [{ id: 'role_stock' }],
};
const pid = (key: string) => `pol_${key}`;

/** RBAC, query and the workflow engine as the script uses them, every
 *  assistant policy live unless `missing` names one. */
function fake({
  roles = [] as Role[],
  links = [] as Link[],
  missing = '',
  heldBy = [] as string[],
} = {}) {
  const policies = keys(true)
    .filter((k) => k !== missing)
    .map((k) => {
      const [resource, operation] = k.split(':');
      return { id: pid(k), resource, operation };
    });
  const rbac = {
    listRbacPolicies: jest.fn(
      async (f: { resource: string; operation: string }) =>
        policies.filter(
          (p) => p.resource === f.resource && p.operation === f.operation,
        ),
    ),
    listRbacRoles: jest.fn(async (f: { name: string }) =>
      roles.filter((r) => r.name === f.name),
    ),
    createRbacRoles: jest.fn(async (d: { name: string }) => {
      const role = { id: `role_new_${roles.length}`, name: d.name };
      roles.push(role);
      return role;
    }),
    listRbacRolePolicies: jest.fn(async (f: Partial<Link>) =>
      links.filter(
        (l) =>
          (!f.role_id || l.role_id === f.role_id) &&
          (!f.policy_id || l.policy_id === f.policy_id),
      ),
    ),
    createRbacRolePolicies: jest.fn(async (d: Link) => {
      links.push(d);
      return d;
    }),
  };
  const workflows = { run: jest.fn(async () => ({})) };
  const anson = {
    ...ANSON,
    rbac_roles: [...ANSON.rbac_roles, ...heldBy.map((id) => ({ id }))],
  };
  const query = { graph: jest.fn(async () => ({ data: [OWNER, anson] })) };
  const services: Record<string, unknown> = {
    [ContainerRegistrationKeys.QUERY]: query,
    [Modules.WORKFLOW_ENGINE]: workflows,
    [Modules.RBAC]: rbac,
  };
  const scope = {
    resolve: (key: string) => services[key],
  } as unknown as MedusaContainer;
  return { scope, rbac, workflows };
}

/** "AI assistant" as an existing role linked to its own policies. */
const chatRole: Role = { id: 'role_ai', name: 'AI assistant' };
const chatLinks = keys(false).map((k) => ({
  role_id: chatRole.id,
  policy_id: pid(k),
}));

describe('grantAssistant', () => {
  it('changes nothing without apply', async () => {
    const { scope, rbac, workflows } = fake();
    expect(
      await grantAssistant(scope, 'anson@polycards.gg', true, false),
    ).toMatch(/^DRY RUN/);
    expect(rbac.createRbacRoles).not.toHaveBeenCalled();
    expect(rbac.createRbacRolePolicies).not.toHaveBeenCalled();
    expect(workflows.run).not.toHaveBeenCalled();
  });

  it('refuses an email with no admin user', async () => {
    const { scope, workflows } = fake();
    await expect(
      grantAssistant(scope, 'nobody@polycards.gg', false, true),
    ).rejects.toThrow(/has no admin user/);
    expect(workflows.run).not.toHaveBeenCalled();
  });

  it('skips a role the user already holds', async () => {
    const { scope, rbac, workflows } = fake({
      roles: [chatRole],
      links: [...chatLinks],
      heldBy: [chatRole.id],
    });
    expect(
      await grantAssistant(scope, 'anson@polycards.gg', false, true),
    ).toMatch(/already has every assistant role/);
    expect(rbac.createRbacRoles).not.toHaveBeenCalled();
    expect(rbac.createRbacRolePolicies).not.toHaveBeenCalled();
    expect(workflows.run).not.toHaveBeenCalled();
  });

  it('throws on a missing policy before any role is made', async () => {
    const { scope, rbac, workflows } = fake({ missing: 'assistant:delete' });
    await expect(
      grantAssistant(scope, 'anson@polycards.gg', false, true),
    ).rejects.toThrow(/No live RBAC policy assistant:delete/);
    expect(rbac.createRbacRoles).not.toHaveBeenCalled();
    expect(workflows.run).not.toHaveBeenCalled();
  });

  it('assigns nothing when the browse role fails after the chat role', async () => {
    const { scope, workflows } = fake({ missing: 'assistant_browse:read' });
    await expect(
      grantAssistant(scope, 'anson@polycards.gg', true, true),
    ).rejects.toThrow(/No live RBAC policy assistant_browse:read/);
    expect(workflows.run).not.toHaveBeenCalled();
  });

  it('refuses a same-named role that holds more than the spec', async () => {
    const { scope, rbac, workflows } = fake({
      roles: [chatRole],
      links: [...chatLinks, { role_id: chatRole.id, policy_id: 'pol_*:*' }],
    });
    await expect(
      grantAssistant(scope, 'anson@polycards.gg', false, true),
    ).rejects.toThrow(/also holds policies outside the assistant's: pol_\*:\*/);
    expect(rbac.createRbacRolePolicies).not.toHaveBeenCalled();
    expect(workflows.run).not.toHaveBeenCalled();
  });
});
