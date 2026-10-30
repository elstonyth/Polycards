import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { SUPPORT_VIEWER_POLICIES } from '../create-support-viewer';
import { grantSupportViewer } from '../grant-support-viewer';

type User = { id: string; email: string; rbac_roles?: { id: string }[] };

const ANSON: User = {
  id: 'user_a',
  email: 'anson@polycards.gg',
  rbac_roles: [{ id: 'role_operator' }],
};
const OWNER: User = {
  id: 'user_o',
  email: 'admin@polycards.gg',
  rbac_roles: [{ id: 'role_super_admin' }],
};

const fakeScope = (users: User[]) => {
  const run = jest.fn(async () => ({}));
  const rbac = {
    listRbacPolicies: async (f: { resource: string; operation: string }) => [
      { id: `${f.resource}:${f.operation}` },
    ],
    listRbacRoles: async () => [{ id: 'role_viewer' }],
    listRbacRolePolicies: async () => [{ id: 'link' }],
  };
  const services: Record<string, unknown> = {
    [ContainerRegistrationKeys.QUERY]: {
      graph: async ({ filters }: { filters?: unknown }) => ({
        data: filters
          ? users.filter((u) => u.email.toLowerCase().includes('anson'))
          : users,
      }),
    },
    [Modules.WORKFLOW_ENGINE]: { run },
    [Modules.RBAC]: rbac,
  };
  return { scope: { resolve: (k: string) => services[k] } as never, run };
};

describe('grantSupportViewer', () => {
  it('writes nothing on a dry run', async () => {
    const { scope, run } = fakeScope([ANSON, OWNER]);
    const out = await grantSupportViewer(scope, ANSON.email, false);
    expect(out).toContain('DRY RUN');
    expect(run).not.toHaveBeenCalled();
  });

  it('adds the shared role beside the current ones, with a super admin as actor', async () => {
    const { scope, run } = fakeScope([ANSON, OWNER]);
    await grantSupportViewer(scope, ANSON.email, true);
    expect(run).toHaveBeenCalledWith('assign-user-roles', {
      input: {
        user_id: ANSON.id,
        role_ids: ['role_viewer'],
        actor_id: OWNER.id,
        actor: 'user',
      },
    });
  });

  it('leaves a user who already has the role alone', async () => {
    const holder = {
      ...ANSON,
      rbac_roles: [...ANSON.rbac_roles!, { id: 'role_viewer' }],
    };
    const { scope, run } = fakeScope([holder, OWNER]);
    const out = await grantSupportViewer(scope, ANSON.email, true);
    expect(out).toContain('already has');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an email with no admin user', async () => {
    const { scope, run } = fakeScope([OWNER]);
    await expect(grantSupportViewer(scope, ANSON.email, true)).rejects.toThrow(
      /has no admin user/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  // The boundary this role depends on: an automation operator can hold it, and
  // must never get to choose whose wallet a live run spends.
  it('carries no write policy that would open the Automation account list', () => {
    expect(SUPPORT_VIEWER_POLICIES.map((p) => p.operation)).not.toContain(
      'update',
    );
  });
});
