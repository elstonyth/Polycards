import { MedusaError } from '@medusajs/framework/utils';
import { POST } from '../route';

// POST /admin/players is three writes across two modules with no shared
// transaction, so what this spec pins is the ORDER and the unwind: nothing is
// written on a refused body, the identity goes first, and a failed customer
// half takes the identity down with it.

const DEFAULT_GROUP = {
  id: 'cgrp_default',
  name: 'DEFAULT',
  metadata: { is_default: true },
};
const PARTNER_GROUP = { id: 'cgrp_partner', name: 'Partner Acc', metadata: {} };

type Opts = {
  taken?: boolean;
  registerError?: string;
  createFails?: boolean;
};

function mkScope(opts: Opts = {}) {
  const calls: string[] = [];
  const customers = {
    retrieveCustomerGroup: async (id: string) => {
      calls.push(`retrieveCustomerGroup:${id}`);
      const g = [DEFAULT_GROUP, PARTNER_GROUP].find((x) => x.id === id);
      if (!g) throw new MedusaError(MedusaError.Types.NOT_FOUND, 'no group');
      return g;
    },
    listCustomers: async () => (opts.taken ? [{ id: 'cus_taken' }] : []),
    createCustomers: async (rows: { email: string }[]) => {
      calls.push('createCustomers');
      if (opts.createFails) throw new Error('insert failed');
      return rows.map((r) => ({ id: 'cus_new', email: r.email }));
    },
    deleteCustomers: async (ids: string[]) => {
      calls.push(`deleteCustomers:${ids.join(',')}`);
    },
    retrieveCustomer: async () => ({ id: 'cus_new' }),
    listCustomerGroups: async (f: Record<string, unknown>) =>
      'customers' in f ? [] : [DEFAULT_GROUP, PARTNER_GROUP],
    addCustomerToGroup: async (p: { customer_group_id: string }) => {
      calls.push(`addCustomerToGroup:${p.customer_group_id}`);
    },
    removeCustomerFromGroup: async () => {
      calls.push('removeCustomerFromGroup');
    },
  };
  const auth = {
    register: async () => {
      calls.push('register');
      return opts.registerError
        ? { success: false, error: opts.registerError }
        : { success: true, authIdentity: { id: 'authid_1' } };
    },
    updateAuthIdentities: async (d: { app_metadata: unknown }) => {
      calls.push(`updateAuthIdentities:${JSON.stringify(d.app_metadata)}`);
    },
    deleteAuthIdentities: async (ids: string[]) => {
      calls.push(`deleteAuthIdentities:${ids.join(',')}`);
    },
  };
  const scope = {
    resolve: (key: string) => (key === 'auth' ? auth : customers),
  };
  return { scope, calls };
}

const mkRes = () => {
  const out: { body?: any; status?: number } = {};
  return {
    res: {
      json: (b: any) => {
        out.body = b;
      },
      status: (s: number) => {
        out.status = s;
        return { json: (b: any) => (out.body = b) };
      },
    } as any,
    out,
  };
};

const run = (scope: unknown, body: unknown) => {
  const { res, out } = mkRes();
  return POST({ scope, body } as any, res).then(() => out);
};

const GOOD = { email: 'Partner-abc123@polycards.gg', password: 'x'.repeat(16) };

describe('POST /admin/players', () => {
  it('refuses a bad email or short password before touching anything', async () => {
    for (const body of [
      { ...GOOD, email: 'nope' },
      { ...GOOD, email: '' },
      { ...GOOD, password: 'short' },
      { ...GOOD, group_id: 7 },
    ]) {
      const { scope, calls } = mkScope();
      await expect(run(scope, body)).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
      });
      expect(calls).toEqual([]);
    }
  });

  it('404s an unknown group before any write', async () => {
    const { scope, calls } = mkScope();
    await expect(
      run(scope, { ...GOOD, group_id: 'cgrp_missing' }),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
    expect(calls).toEqual(['retrieveCustomerGroup:cgrp_missing']);
  });

  it('refuses an email already held by an account, without minting a login', async () => {
    const { scope, calls } = mkScope({ taken: true });
    await expect(run(scope, GOOD)).rejects.toMatchObject({
      type: MedusaError.Types.DUPLICATE_ERROR,
    });
    expect(calls).toEqual([]);
  });

  it("surfaces the provider's refusal and creates no customer", async () => {
    const { scope, calls } = mkScope({
      registerError: 'Identity with email already exists',
    });
    await expect(run(scope, GOOD)).rejects.toMatchObject({
      type: MedusaError.Types.DUPLICATE_ERROR,
      message: 'Identity with email already exists',
    });
    expect(calls).toEqual(['register']);
  });

  it('identity → customer → link → group, lowercased email, 201', async () => {
    const { scope, calls } = mkScope();
    const out = await run(scope, { ...GOOD, group_id: 'cgrp_partner' });
    expect(out.status).toBe(201);
    expect(out.body).toEqual({
      player: {
        id: 'cus_new',
        email: 'partner-abc123@polycards.gg',
        group: { id: 'cgrp_partner', name: 'Partner Acc' },
      },
    });
    // The second retrieve is setPlayerGroup's own (shared with the /group
    // route); the first is this route's pre-write 404 check.
    expect(calls).toEqual([
      'retrieveCustomerGroup:cgrp_partner',
      'register',
      'createCustomers',
      'updateAuthIdentities:{"customer_id":"cus_new"}',
      'retrieveCustomerGroup:cgrp_partner',
      'addCustomerToGroup:cgrp_partner',
    ]);
  });

  it('lands in DEFAULT when group_id is omitted', async () => {
    const { scope, calls } = mkScope();
    const out = await run(scope, GOOD);
    expect(out.body.player.group).toEqual({
      id: 'cgrp_default',
      name: 'DEFAULT',
    });
    expect(calls).toContain('addCustomerToGroup:cgrp_default');
  });

  it('deletes the identity when the customer half fails, rethrowing the cause', async () => {
    const { scope, calls } = mkScope({ createFails: true });
    await expect(run(scope, GOOD)).rejects.toThrow('insert failed');
    expect(calls).toEqual([
      'register',
      'createCustomers',
      'deleteAuthIdentities:authid_1',
    ]);
  });
});
