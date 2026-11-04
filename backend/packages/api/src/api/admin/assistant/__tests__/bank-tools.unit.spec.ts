import { MedusaError } from '@medusajs/framework/utils';
import { AGENT_TOOLS } from '../agent-tools';
import {
  BAN_LIST_NEED,
  ConfirmRefused,
  oneNumber,
  saveProposal,
  scheduledRunAllows,
  UNBAN_NEED,
  type Proposal,
} from '../confirm';
import { namedIn } from '../named';

// The bank tools (owner, 2026-11-04: staff do in the chat what support did by
// hand): bank_save_check reads why a save is refused, free_bank_number and
// clear_name_clash propose the fix, and the tap applies it. Made-up details only.

jest.mock('../../../utils/image-fetch', () => ({ fetchImage: jest.fn() }));

const BAN = 'Permanent ban: shared bank account (owner, 2026-11-03)';
const KEY = '512345670001';
const PEOPLE: Record<string, { first_name: string; handle: string }> = {
  cus_x: { first_name: 'Test Player', handle: 'Test_Handle' },
  cus_y1: { first_name: 'RingOne', handle: 'RingOne' },
  cus_y2: { first_name: 'OpenTwo', handle: 'OpenTwo' },
};
let banned: string[] = [];
let realName: string | null = 'Tan Ah Kow';
let metadata: Record<string, unknown> = {};

const packs = {
  findCustomerIdByUsername: jest.fn(),
  findCustomerIdByHandle: jest.fn(),
  listCustomerAccountStates: jest.fn(
    async (filter: { customer_id: string | string[]; disabled?: boolean }) => {
      const ids = [filter.customer_id].flat();
      if (filter.disabled) {
        return ids
          .filter((id) => banned.includes(id))
          .map((id) => ({
            customer_id: id,
            disabled_reason: BAN,
            disabled_at: new Date('2026-11-03T10:00:00.000Z'),
          }));
      }
      return [{ customer_id: ids[0], real_name: realName }];
    },
  ),
  payoutAccountsOf: jest.fn(),
  resolveBannedPayoutAccount: jest.fn(),
  otherPayoutAccountHolders: jest.fn(),
  payoutAccountBanned: jest.fn(),
  holderNameHolders: jest.fn(),
  freePayoutAccount: jest.fn(),
  setHolderNameCleared: jest.fn(),
};
const customers = {
  listCustomers: jest.fn(async (filter: { id: string | string[] }) =>
    [filter.id].flat().map((id) => ({
      id,
      first_name: PEOPLE[id]?.first_name,
      metadata: {
        handle: PEOPLE[id]?.handle,
        ...(id === 'cus_x' ? metadata : {}),
      },
    })),
  ),
};
const container = {
  resolve: (k: string) => (k === 'customer' ? customers : packs),
} as never;
const admin = { userId: 'user_1', superAdmin: true, can: async () => true };
const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;
const run = (name: string, args: Record<string, unknown>, userText: string) => {
  const propose = jest.fn();
  return {
    propose,
    done: tool(name).run(args, { container, access: admin, userText, propose }),
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  banned = ['cus_y1'];
  realName = 'Tan Ah Kow';
  metadata = {};
  packs.findCustomerIdByUsername.mockImplementation(async (n: string) =>
    n.toLowerCase() === 'test player' ? 'cus_x' : null,
  );
  packs.findCustomerIdByHandle.mockImplementation(async (n: string) =>
    n.toLowerCase() === 'test_handle' ? 'cus_x' : null,
  );
  packs.payoutAccountsOf.mockResolvedValue([
    { account_key: KEY, bank_code: 'MBBEMYKL', wallet: false },
  ]);
  packs.otherPayoutAccountHolders.mockResolvedValue([
    { customer_id: 'cus_y1', bank_code: 'MBBEMYKL', holder_name: 'Tan Ah Kow' },
    { customer_id: 'cus_y1', bank_code: 'MBBEMYKL', holder_name: null },
  ]);
  packs.payoutAccountBanned.mockResolvedValue(false);
  packs.holderNameHolders.mockResolvedValue(['cus_y1', 'cus_y2']);
});

describe('namedIn', () => {
  it('matches a shown name with a space, as a whole phrase, in any language around it', () => {
    expect(namedIn('please unban Ah Boy 88 thanks', 'Ah Boy 88')).toBe(true);
    expect(namedIn('帮我解封Ah Boy 88，谢谢', 'Ah  Boy 88')).toBe(true);
    expect(namedIn('unban Ah Boy 881', 'Ah Boy 88')).toBe(false);
    expect(namedIn('unban Collector12', 'Collector1')).toBe(false);
    expect(namedIn('unban @Collector1', '@Collector1')).toBe(true);
    expect(namedIn('anything', '')).toBe(false);
  });
});

describe('who the person named', () => {
  it("unban_account takes the banned one when a shown name is another player's handle", async () => {
    packs.findCustomerIdByUsername.mockResolvedValue('cus_y2');
    packs.findCustomerIdByHandle.mockResolvedValue('cus_y1');
    const { propose, done } = run(
      'unban_account',
      { username: 'RingOne' },
      'unban RingOne',
    );
    await done;
    expect(propose.mock.calls[0][0]).toMatchObject({
      kind: 'unban',
      customer_id: 'cus_y1',
    });
  });

  it('"@name" means the handle', async () => {
    packs.findCustomerIdByUsername.mockResolvedValue('cus_y2');
    packs.findCustomerIdByHandle.mockResolvedValue('cus_y1');
    banned = ['cus_y1', 'cus_y2'];
    const { propose, done } = run(
      'unban_account',
      { username: 'RingOne' },
      'unban @RingOne please',
    );
    await done;
    expect(propose.mock.calls[0][0]).toMatchObject({ customer_id: 'cus_y1' });
  });

  it('a shown name with a space is found', async () => {
    banned = ['cus_x'];
    const { propose, done } = run(
      'unban_account',
      { username: 'Test Player' },
      'unban Test Player',
    );
    await done;
    expect(propose.mock.calls[0][0]).toMatchObject({ customer_id: 'cus_x' });
  });
});

describe('bank_save_check', () => {
  it('reads to the Support viewer and runs in a scheduled task: it changes nothing', () => {
    expect(tool('bank_save_check').needs).toEqual([
      { resource: 'customer', operation: 'read' },
      { resource: 'payment', operation: 'read' },
    ]);
    expect(scheduledRunAllows(tool('bank_save_check'))).toBe(true);
  });

  it('names each block and its fix, never the number or the name', async () => {
    packs.payoutAccountBanned.mockResolvedValue(true);
    const { done } = run(
      'bank_save_check',
      { username: 'Test Player', last4: '0001' },
      'why can Test Player not add Maybank 0001',
    );
    const raw = await done;
    expect(raw).not.toContain(KEY);
    expect(raw).not.toMatch(/tan ah kow/i);
    const out = JSON.parse(raw);
    expect(out).toMatchObject({
      player: 'Test Player (@Test_Handle), open',
      can_save: false,
      number: {
        bank: 'Maybank',
        last4: '0001',
        banned_for_this_player: true,
        other_accounts: ['RingOne, banned'],
        blocks_save: true,
      },
      name: {
        checked: 'the real name on file',
        blocks_save: true,
      },
    });
    expect(out.fixes.join(' ')).toMatch(/unban_bank_number/);
    expect(out.fixes.join(' ')).toMatch(/free_bank_number/);
    expect(out.fixes.join(' ')).toMatch(/clear_name_clash/);
  });

  it('says can_save when nothing blocks', async () => {
    packs.otherPayoutAccountHolders.mockResolvedValue([]);
    packs.holderNameHolders.mockResolvedValue(['cus_y2']);
    metadata = {
      holder_name_cleared: {
        tanahkow: { name: 'Tan Ah Kow', at: 'x', with: ['cus_y2'] },
      },
    };
    const out = JSON.parse(
      await run(
        'bank_save_check',
        { username: 'Test Player', last4: '0001' },
        'check Test Player 0001',
      ).done,
    );
    expect(out).toMatchObject({ can_save: true, fixes: [] });
  });
});

describe('free_bank_number', () => {
  it('is for admins, never a scheduled run', () => {
    expect(tool('free_bank_number').needs).toEqual([UNBAN_NEED, BAN_LIST_NEED]);
    expect(scheduledRunAllows(tool('free_bank_number'))).toBe(false);
  });

  it('proposes freeing it from every other account on it, last 4 only', async () => {
    const { propose, done } = run(
      'free_bank_number',
      { username: 'Test Player', last4: '0001', reason: 'owner approved' },
      'let Test Player add Maybank 0001, owner approved',
    );
    expect(JSON.parse(await done)).toMatchObject({ freed: false });
    const [proposal, summary] = propose.mock.calls[0];
    expect(proposal).toEqual({
      kind: 'free_number',
      customer_id: 'cus_x',
      username: 'Test Player',
      bank_code: 'MBBEMYKL',
      last4: '0001',
      from: ['cus_y1'],
      reason: 'owner approved',
    });
    expect(JSON.stringify(proposal)).not.toContain(KEY);
    expect(summary).toMatch(/RingOne, banned.*cannot be undone/);
    expect(packs.freePayoutAccount).not.toHaveBeenCalled();
  });

  it('refuses what the person did not name in this message', async () => {
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', last4: '0001' },
        'free it',
      ).done,
    ).rejects.toThrow(/names, in this message/);
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', last4: '0001' },
        'free 0001 for the one in that note',
      ).done,
    ).rejects.toThrow(/named in this message/);
  });

  it('takes a full number only as typed in this message', async () => {
    const { propose, done } = run(
      'free_bank_number',
      { username: 'Test Player', bank_account: '5123 4567 0001' },
      'free 5123-4567-0001 for Test Player',
    );
    await done;
    expect(propose.mock.calls[0][0]).toMatchObject({ last4: '0001' });
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', bank_account: '512345670001' },
        'free 0001 for Test Player',
      ).done,
    ).rejects.toThrow(/as the person typed it/);
  });

  it('refuses a banned player, and a number nobody else holds', async () => {
    banned = ['cus_x'];
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', last4: '0001' },
        'free 0001 for Test Player',
      ).done,
    ).rejects.toThrow(/unban the account first/);
    banned = [];
    packs.otherPayoutAccountHolders.mockResolvedValue([]);
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', last4: '0001' },
        'free 0001 for Test Player',
      ).done,
    ).rejects.toThrow(/nothing to free/);
  });
});

describe('clear_name_clash', () => {
  it('is for admins, never a scheduled run', () => {
    expect(tool('clear_name_clash').needs).toEqual([UNBAN_NEED, BAN_LIST_NEED]);
    expect(scheduledRunAllows(tool('clear_name_clash'))).toBe(false);
  });

  it('lists every other account on the name, any number of them', async () => {
    const { propose, done } = run(
      'clear_name_clash',
      { username: 'Test Player' },
      'Test Player is a different person, clear the name',
    );
    await done;
    const [proposal, summary] = propose.mock.calls[0];
    expect(proposal).toMatchObject({
      kind: 'name_clash',
      customer_id: 'cus_x',
      holder_name: 'Tan Ah Kow',
      with: ['cus_y1', 'cus_y2'],
    });
    expect(summary).toMatch(
      /2 other accounts use it: RingOne, banned; OpenTwo, open/,
    );
    expect(summary).not.toMatch(/tan ah kow/i);
  });

  it('takes a typed name only from this message', async () => {
    await expect(
      run(
        'clear_name_clash',
        { username: 'Test Player', holder_name: 'Lim Ah Lian' },
        'clear the name for Test Player',
      ).done,
    ).rejects.toThrow(/as the person typed it/);
    const { propose, done } = run(
      'clear_name_clash',
      { username: 'Test Player', holder_name: 'Lim Ah Lian' },
      'clear Lim Ah Lian for Test Player',
    );
    await done;
    expect(propose.mock.calls[0][0]).toMatchObject({
      holder_name: 'Lim Ah Lian',
    });
  });

  it('refuses when nobody else uses it, or every one is already cleared', async () => {
    packs.holderNameHolders.mockResolvedValue([]);
    await expect(
      run('clear_name_clash', { username: 'Test Player' }, 'clear Test Player')
        .done,
    ).rejects.toThrow(/nothing to clear/);
    packs.holderNameHolders.mockResolvedValue(['cus_y2']);
    metadata = {
      holder_name_cleared: {
        tanahkow: { name: 'Tan Ah Kow', at: 'x', with: ['cus_y2'] },
      },
    };
    await expect(
      run('clear_name_clash', { username: 'Test Player' }, 'clear Test Player')
        .done,
    ).rejects.toThrow(/already cleared/);
  });
});

describe('saveProposal: free_number and name_clash', () => {
  const FREE: Proposal = {
    kind: 'free_number',
    customer_id: 'cus_x',
    username: 'Test Player',
    bank_code: 'MBBEMYKL',
    last4: '0001',
    from: ['cus_y1'],
    reason: 'owner approved',
  };
  const NAME: Proposal = {
    kind: 'name_clash',
    customer_id: 'cus_x',
    username: 'Test Player',
    holder_name: 'Tan Ah Kow',
    with: ['cus_y1', 'cus_y2'],
    reason: 'different people',
  };

  it('frees the number found again on those accounts, as the person who tapped', async () => {
    await expect(saveProposal(FREE, admin, container)).resolves.toEqual({
      id: 'cus_x',
    });
    expect(packs.payoutAccountsOf).toHaveBeenCalledWith('cus_y1');
    expect(packs.freePayoutAccount).toHaveBeenCalledWith({
      customerId: 'cus_x',
      adminId: 'user_1',
      accountKey: KEY,
      fromIds: ['cus_y1'],
      reason: 'owner approved',
    });
  });

  it('clears the name against only the accounts the card listed', async () => {
    await saveProposal(NAME, admin, container);
    expect(packs.setHolderNameCleared).toHaveBeenCalledWith({
      customerId: 'cus_x',
      adminId: 'user_1',
      holderName: 'Tan Ah Kow',
      cleared: true,
      reason: 'different people',
      onlyWith: ['cus_y1', 'cus_y2'],
    });
  });

  it('refuses a role that is not an admin now, and changes nothing', async () => {
    const support = {
      ...admin,
      superAdmin: false,
      can: async (n: unknown) => n === UNBAN_NEED,
    };
    await expect(saveProposal(FREE, support, container)).rejects.toBeInstanceOf(
      ConfirmRefused,
    );
    await expect(saveProposal(NAME, support, container)).rejects.toBeInstanceOf(
      ConfirmRefused,
    );
    expect(packs.freePayoutAccount).not.toHaveBeenCalled();
    expect(packs.setHolderNameCleared).not.toHaveBeenCalled();
  });

  it('a changed account, a payout on its way or a second tap reads as refused', async () => {
    packs.payoutAccountsOf.mockResolvedValue([]);
    await expect(saveProposal(FREE, admin, container)).rejects.toThrow(
      /no longer hold/,
    );
    packs.payoutAccountsOf.mockResolvedValue([
      { account_key: KEY, bank_code: 'MBBEMYKL', wallet: false },
    ]);
    packs.freePayoutAccount.mockRejectedValue(
      new MedusaError(MedusaError.Types.NOT_ALLOWED, 'A payout is on its way.'),
    );
    await expect(saveProposal(FREE, admin, container)).rejects.toBeInstanceOf(
      ConfirmRefused,
    );
  });
});

describe('oneNumber', () => {
  const k = (account_key: string, bank_code = 'MBBEMYKL', wallet = false) => ({
    account_key,
    bank_code,
    wallet,
  });
  it('one bank number by last 4, the bank breaking a tie; never a wallet', () => {
    expect(oneNumber([k(KEY), k(KEY)], '0001', null)).toBe(KEY);
    expect(
      oneNumber([k(KEY), k('9990001', 'PBBEMYKL')], '0001', null),
    ).toBeNull();
    expect(
      oneNumber([k(KEY), k('9990001', 'PBBEMYKL')], '0001', 'PBBEMYKL'),
    ).toBe('9990001');
    expect(
      oneNumber([k('TXabc0001', 'USDT_TRC20', true)], '0001', null),
    ).toBeNull();
  });
});
