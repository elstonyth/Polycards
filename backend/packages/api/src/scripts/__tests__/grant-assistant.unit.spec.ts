import { assistantPolicies } from '../../policies/assistant';
import { adminSurfacePolicies } from '../../policies/admin-surfaces';
import { assistantRolesFor } from '../grant-assistant';

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
