import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import {
  listPartnerAccounts,
  mintPartnerAccount,
  PARTNER_CREDENTIAL_KEY,
} from '../../../../utils/partner-accounts';
import { POST } from '../route';

// The generator is three modules and five writes with no shared transaction,
// so what this spec pins is the ORDER, the unwind, and that the credential
// the operator receives is the one stored and the one the identity was
// registered with. Generation itself is asserted by shape only (the alphabets
// are the contract; randomness is node's).

const EMAIL_RE =
  /^partner-[abcdefghijkmnpqrstuvwxyz23456789]{6}@polycards\.gg$/;
const PASSWORD_RE =
  /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{16}$/;

const DEFAULT_GROUP = {
  id: 'cgrp_default',
  name: 'DEFAULT',
  metadata: { is_default: true },
};
const PARTNER_GROUP = { id: 'cgrp_partner', name: 'Partner Acc', metadata: {} };

type Opts = {
  /** How many generated emails are already taken before a free one. */
  emailsTaken?: number;
  registerError?: string;
  claimFails?: boolean;
  nameOwner?: string | null;
  /** Rows listAndCountCustomers pages out (listPartnerAccounts). */
  customers?: Array<Record<string, unknown>>;
};

function mkContainer(opts: Opts = {}) {
  const calls: string[] = [];
  const seen: {
    registered?: { email: string; password: string };
    created?: Record<string, unknown>;
    claimed?: string;
  } = {};
  let emailChecks = 0;
  let nextId = 0;
  const customers = {
    listCustomers: async () =>
      emailChecks++ < (opts.emailsTaken ?? 0) ? [{ id: 'cus_taken' }] : [],
    listAndCountCustomers: async (
      _f: unknown,
      o: { skip: number; take: number },
    ) => {
      const all = opts.customers ?? [];
      return [all.slice(o.skip, o.skip + o.take), all.length];
    },
    createCustomers: async (rows: Record<string, unknown>[]) => {
      calls.push('createCustomers');
      seen.created = rows[0];
      return rows.map((r) => ({
        ...r,
        id: `cus_${++nextId}`,
        created_at: new Date('2026-09-09T00:00:00Z'),
      }));
    },
    deleteCustomers: async (ids: string[]) => {
      calls.push(`deleteCustomers:${ids.join(',')}`);
    },
    retrieveCustomer: async (id: string) => ({ id }),
    retrieveCustomerGroup: async (id: string) => {
      calls.push(`retrieveCustomerGroup:${id}`);
      const g = [DEFAULT_GROUP, PARTNER_GROUP].find((x) => x.id === id);
      if (!g) throw new MedusaError(MedusaError.Types.NOT_FOUND, 'no group');
      return g;
    },
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
    register: async (
      _p: string,
      d: { body: { email: string; password: string } },
    ) => {
      calls.push('register');
      seen.registered = d.body;
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
  const packs = {
    claimUsername: async (i: { desired: string }) => {
      calls.push('claimUsername');
      if (opts.claimFails) throw new Error('claim failed');
      seen.claimed = i.desired;
      return i.desired;
    },
    findCustomerIdByUsername: async () => opts.nameOwner ?? null,
  };
  const container = {
    resolve: (key: string) =>
      key === 'auth' ? auth : key === PACKS_MODULE ? packs : customers,
  } as any;
  return { container, calls, seen };
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

const post = (scope: unknown, body: unknown) => {
  const { res, out } = mkRes();
  return POST({ scope, body } as any, res).then(() => out);
};

describe('mintPartnerAccount', () => {
  it('identity → customer (credential stored) → link → name → group', async () => {
    const { container, calls, seen } = mkContainer();
    const row = await mintPartnerAccount(container, {
      displayName: null,
      groupId: 'cgrp_partner',
    });
    expect(row.email).toMatch(EMAIL_RE);
    expect(row.password).toMatch(PASSWORD_RE);
    // The one password, everywhere: registered, stored, returned.
    expect(seen.registered).toEqual({
      email: row.email,
      password: row.password,
    });
    expect(seen.created).toMatchObject({
      email: row.email,
      has_account: true,
      metadata: { [PARTNER_CREDENTIAL_KEY]: { password: row.password } },
    });
    expect(row.name).toMatch(/^Collector\d{4}$/);
    expect(row.group).toBe('Partner Acc');
    expect(calls).toEqual([
      'register',
      'createCustomers',
      'updateAuthIdentities:{"customer_id":"cus_1"}',
      'claimUsername',
      'retrieveCustomerGroup:cgrp_partner',
      'addCustomerToGroup:cgrp_partner',
    ]);
  });

  it('claims a typed display name as given, and DEFAULT without a group', async () => {
    const { container, seen } = mkContainer();
    const row = await mintPartnerAccount(container, {
      displayName: 'Ada_1',
      groupId: null,
    });
    expect(seen.claimed).toBe('Ada_1');
    expect(row.group).toBe('DEFAULT');
  });

  it('skips a generated email that is already an account', async () => {
    const { container, calls } = mkContainer({ emailsTaken: 2 });
    await mintPartnerAccount(container, { displayName: null, groupId: null });
    expect(calls.filter((c) => c === 'register')).toHaveLength(1);
  });

  it("surfaces the provider's refusal and creates no customer", async () => {
    const { container, calls } = mkContainer({
      registerError: 'Identity with email already exists',
    });
    await expect(
      mintPartnerAccount(container, { displayName: null, groupId: null }),
    ).rejects.toMatchObject({
      type: MedusaError.Types.DUPLICATE_ERROR,
      message: 'Identity with email already exists',
    });
    expect(calls).toEqual(['register']);
  });

  it('removes identity AND customer when a later write fails', async () => {
    const { container, calls } = mkContainer({ claimFails: true });
    await expect(
      mintPartnerAccount(container, { displayName: null, groupId: null }),
    ).rejects.toThrow('claim failed');
    expect(calls).toEqual([
      'register',
      'createCustomers',
      'updateAuthIdentities:{"customer_id":"cus_1"}',
      'claimUsername',
      'deleteAuthIdentities:authid_1',
      'deleteCustomers:cus_1',
    ]);
  });
});

describe('POST /admin/players', () => {
  it('refuses a bad count, name or group type before touching anything', async () => {
    for (const body of [
      { count: 0 },
      { count: 51 },
      { count: 1.5 },
      { count: '2' },
      { display_name: 'no spaces here' },
      { display_name: 'ab' },
      { display_name: 7 },
      { group_id: 7 },
    ]) {
      const { container, calls } = mkContainer();
      await expect(post(container, body)).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
      });
      expect(calls).toEqual([]);
    }
  });

  it('404s an unknown group and 422s a taken name before any write', async () => {
    const missing = mkContainer();
    await expect(
      post(missing.container, { group_id: 'cgrp_missing' }),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
    expect(missing.calls).toEqual(['retrieveCustomerGroup:cgrp_missing']);

    const taken = mkContainer({ nameOwner: 'cus_other' });
    await expect(
      post(taken.container, { display_name: 'Ada_1' }),
    ).rejects.toMatchObject({ type: MedusaError.Types.DUPLICATE_ERROR });
    expect(taken.calls).toEqual([]);
  });

  it('mints `count` accounts (default 1) and answers 201 with every credential', async () => {
    const one = mkContainer();
    const single = await post(one.container, {});
    expect(single.status).toBe(201);
    expect(single.body.players).toHaveLength(1);

    const three = mkContainer();
    const batch = await post(three.container, {
      count: 3,
      group_id: 'cgrp_partner',
    });
    expect(batch.body.players).toHaveLength(3);
    const emails = new Set(batch.body.players.map((p: any) => p.email));
    expect(emails.size).toBe(3);
    for (const p of batch.body.players) {
      expect(p.password).toMatch(PASSWORD_RE);
      expect(p.group).toBe('Partner Acc');
    }
    expect(three.calls.filter((c) => c === 'createCustomers')).toHaveLength(3);
  });
});

describe('listPartnerAccounts', () => {
  it('pages every account and keeps only rows carrying the credential', () => {
    const row = (i: number, minted: boolean) => ({
      id: `cus_${i}`,
      email: `p${i}@test.dev`,
      first_name: `Name${i}`,
      created_at: new Date('2026-09-09T00:00:00Z'),
      groups: [{ name: 'Partner Acc' }],
      metadata: minted
        ? { [PARTNER_CREDENTIAL_KEY]: { password: `pw${i}`, issued_at: 'x' } }
        : { avatar_url: 'a.png' },
    });
    // 1200 rows across three 500-row pages; every third one was minted here.
    const all = Array.from({ length: 1200 }, (_, i) => row(i, i % 3 === 0));
    const { container } = mkContainer({ customers: all });
    return listPartnerAccounts(container).then((rows) => {
      expect(rows).toHaveLength(400);
      expect(rows[0]).toEqual({
        id: 'cus_0',
        email: 'p0@test.dev',
        password: 'pw0',
        name: 'Name0',
        group: 'Partner Acc',
        created_at: '2026-09-09T00:00:00.000Z',
      });
    });
  });
});
