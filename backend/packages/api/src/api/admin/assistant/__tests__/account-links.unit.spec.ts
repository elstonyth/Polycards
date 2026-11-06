import {
  accountLinks,
  addressKey,
  realNameMatch,
  VISITOR_NEED,
  type LinksDb,
} from '../account-links';
import { AGENT_TOOLS } from '../agent-tools';

// account_links (owner, 2026-11-06): the assistant called two accounts of one
// person "independent" because ban_reason sees banks and holder names only.
// Made-up people and places only.

jest.mock('../../../utils/image-fetch', () => ({ fetchImage: jest.fn() }));

const IP_PAIR = '2405:3800:aaaa:bbbb::/64';
const IP_CROWD = '175.140.1.1';
const STREET = '12, Jalan Contoh Indah ';
const REAL = 'Test Person Satu Dua';

type Row = Record<string, unknown>;
let rows: {
  myName: Row[];
  names: Row[];
  myAddresses: Row[];
  addresses: Row[];
};
const db = {
  raw: jest.fn(async (sql: string) => {
    if (sql.includes('FROM customer_account_state s'))
      return { rows: rows.names };
    if (sql.includes('FROM customer_account_state'))
      return { rows: rows.myName };
    if (sql.includes('FROM customer_address a'))
      return { rows: rows.addresses };
    if (sql.includes('FROM customer_address'))
      return { rows: rows.myAddresses };
    throw new Error(`unexpected SQL: ${sql}`);
  }),
};
const packs = {
  visitorSignalMatches: jest.fn(),
  createAdminActionAudits: jest.fn(),
  findCustomerIdByUsername: jest.fn(),
  findCustomerIdByHandle: jest.fn(),
  listCustomerAccountStates: jest.fn(async () => []),
};
const label = async (ids: string[]) =>
  ids.map((id) => ({ id, label: `${id} shown, open` }));

const find = (visitors: boolean) =>
  accountLinks({
    db: db as unknown as LinksDb,
    packs,
    customerId: 'cus_a',
    adminId: 'user_1',
    visitors,
    label,
  });

beforeEach(() => {
  jest.clearAllMocks();
  rows = {
    myName: [{ real_name: REAL }],
    names: [
      { customer_id: 'cus_b', real_name: 'test person' },
      // Same first two words, then a different person.
      { customer_id: 'cus_e', real_name: 'Test Person Lain' },
    ],
    myAddresses: [{ address_1: STREET, address_2: null, postal_code: '93450' }],
    addresses: [
      {
        customer_id: 'cus_b',
        address_1: '12,Jln Contoh Indah',
        address_2: '',
        postal_code: '93450',
      },
      {
        customer_id: 'cus_f',
        address_1: '14, Jalan Contoh Indah',
        address_2: null,
        postal_code: '93450',
      },
    ],
  };
  packs.visitorSignalMatches.mockResolvedValue({
    recorded: true,
    unsigned: false,
    device: [
      { customer_id: 'cus_b', last_seen_at: '2026-11-05T21:02:41.000Z' },
    ],
    device_total: 1,
    ip: [
      { ip: IP_PAIR, accounts: 2, customer_ids: ['cus_b'] },
      {
        ip: IP_CROWD,
        accounts: 40,
        customer_ids: [
          'cus_c',
          'cus_b',
          'cus_g',
          'cus_h',
          'cus_i',
          'cus_j',
          'cus_k',
          'cus_l',
          'cus_m',
          'cus_n',
        ],
      },
    ],
    ip_total: 2,
  });
});

describe('addressKey', () => {
  it('evens out case, commas, spaces and Jalan/Jln', () => {
    expect(addressKey(['292, Jalan Bintang Tengah '], '93450')).toBe(
      addressKey(['292,Jln Bintang Tengah'], ' 93450 '),
    );
    expect(addressKey(['Blk 5', 'Ang Mo Kio Avenue 3'], '560005')).toBe(
      addressKey(['Block 5 Ang Mo Kio Ave 3'], '560005'),
    );
  });

  it('keeps the house number and the postcode apart', () => {
    expect(addressKey(['12 Jalan Contoh'], '93450')).not.toBe(
      addressKey(['14 Jalan Contoh'], '93450'),
    );
    expect(addressKey(['12 Jalan Contoh'], '93450')).not.toBe(
      addressKey(['12 Jalan Contoh'], '93460'),
    );
  });

  it('gives no key without a postcode or a street', () => {
    expect(addressKey(['12 Jalan Contoh'], '')).toBeNull();
    expect(addressKey([null, '  '], '93450')).toBeNull();
  });
});

describe('realNameMatch', () => {
  it('calls a name that starts the longer one part of it', () => {
    expect(realNameMatch('Alex Tan', 'Alex Tan tan seng')).toBe('part');
    expect(realNameMatch('Tan Ah Kow', 'TAN  AH')).toBe('part');
  });

  it('calls one name the same whatever its case and separators', () => {
    expect(realNameMatch('Siti binti Ali', 'siti BINTI ali')).toBe('same');
    expect(realNameMatch('Raj a/l Kumar', 'raj a l kumar')).toBe('same');
  });

  it('never matches on one word, or on a name that only shares a start', () => {
    expect(realNameMatch('Alex', 'Alex Tan')).toBeNull();
    expect(realNameMatch('Alex Tan', 'Alex Hong')).toBeNull();
    expect(realNameMatch('Test Person Lain', REAL)).toBeNull();
  });
});

describe('accountLinks', () => {
  it('lists every signal per account, strongest first', async () => {
    const out = await find(true);
    expect(out.checked).toEqual({
      browser_and_network: true,
      delivery_address: true,
      real_name: true,
    });
    expect(out.accounts[0]).toEqual({
      account: 'cus_b shown, open',
      same_browser: true,
      shared_networks: [2],
      same_delivery_address: true,
      real_name: 'part',
    });
    // A crowded network lists only some of its accounts: left out, counted.
    expect(out.accounts.map((a) => a.account)).toEqual(['cus_b shown, open']);
    expect(out.crowded_networks_left_out).toBe(1);
  });

  it('never hands an IP, address or real name to the model', async () => {
    const text = JSON.stringify(await find(true));
    for (const secret of [
      IP_PAIR,
      IP_CROWD,
      'Contoh',
      '93450',
      'Test Person',
      'Satu',
    ]) {
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    }
  });

  it('records that staff saw browser and network matches, counts only', async () => {
    await find(true);
    expect(packs.createAdminActionAudits).toHaveBeenCalledWith([
      expect.objectContaining({
        admin_id: 'user_1',
        entity_type: 'customer',
        entity_id: 'cus_a',
        action: 'reveal',
        after: { same_browser: 1, same_network: 2 },
      }),
    ]);
  });

  it('skips browser and network without the bank-details permission, and says so', async () => {
    const out = await find(false);
    expect(packs.visitorSignalMatches).not.toHaveBeenCalled();
    expect(packs.createAdminActionAudits).not.toHaveBeenCalled();
    expect(out.checked.browser_and_network).toBe(false);
    expect(out.accounts[0]).toEqual({
      account: 'cus_b shown, open',
      same_browser: false,
      shared_networks: [],
      same_delivery_address: true,
      real_name: 'part',
    });
  });

  it('skips the name search for a one-word real name', async () => {
    rows.myName = [{ real_name: 'Alex' }];
    const out = await find(true);
    expect(out.checked.real_name).toBe(false);
    expect(
      db.raw.mock.calls.some(([sql]) =>
        sql.includes('customer_account_state s'),
      ),
    ).toBe(false);
  });

  it('says no signal was found, never that the accounts are unrelated', async () => {
    rows.names = [];
    rows.addresses = [];
    packs.visitorSignalMatches.mockResolvedValue({
      recorded: true,
      unsigned: false,
      device: [],
      device_total: 0,
      ip: [],
      ip_total: 0,
    });
    const out = await find(true);
    expect(out.accounts).toEqual([]);
    expect(out.summary).toMatch(/no .*match/i);
    expect(out.summary).toMatch(/not proof/i);
    expect(packs.createAdminActionAudits).not.toHaveBeenCalled();
  });
});

describe('account_links tool', () => {
  const tool = AGENT_TOOLS.find((t) => t.name === 'account_links')!;
  const customers = {
    listCustomers: jest.fn(async (filter: { id: string | string[] }) =>
      [filter.id]
        .flat()
        .map((id) => ({ id, first_name: id, metadata: { handle: id } })),
    ),
  };
  const container = {
    resolve: (k: string) =>
      k === '__pg_connection__' ? db : k === 'customer' ? customers : packs,
  } as never;
  beforeEach(() => {
    packs.findCustomerIdByHandle.mockResolvedValue(null);
    packs.findCustomerIdByUsername.mockImplementation(async (n: string) =>
      n === 'cus_a' ? 'cus_a' : null,
    );
  });

  it('asks for the bank-details permission before reading browsers and networks', async () => {
    const can = jest.fn(async () => false);
    const out = JSON.parse(
      await tool.run({ username: 'cus_a' }, {
        container,
        access: { userId: 'user_2', superAdmin: false, can },
      } as never),
    );
    expect(can).toHaveBeenCalledWith(VISITOR_NEED);
    expect(packs.visitorSignalMatches).not.toHaveBeenCalled();
    expect(out.player).toBe('cus_a, open');
    expect(out.accounts[0].account).toBe('cus_b, open');
  });

  it('reads them for a super admin', async () => {
    await tool.run({ username: 'cus_a' }, {
      container,
      access: { userId: 'user_1', superAdmin: true },
    } as never);
    expect(packs.visitorSignalMatches).toHaveBeenCalledWith('cus_a');
  });
});
