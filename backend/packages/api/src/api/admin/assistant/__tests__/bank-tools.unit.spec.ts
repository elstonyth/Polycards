import { MedusaError } from '@medusajs/framework/utils';
import { AGENT_TOOLS } from '../agent-tools';
import {
  BAN_LIST_NEED,
  ConfirmRefused,
  numberMark,
  oneNumber,
  saveProposal,
  scheduledRunAllows,
  UNBAN_NEED,
  type Proposal,
} from '../confirm';
import { namedIn, namedPlayer } from '../named';

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
// admin_action_audit rows written after a card was made.
let audits: { after: Record<string, unknown> }[] = [];

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
  payoutAccountHoldersAt: jest.fn(),
  payoutAccountBanned: jest.fn(),
  holderNameHolders: jest.fn(),
  freePayoutAccount: jest.fn(),
  setHolderNameCleared: jest.fn(),
  listAdminActionAudits: jest.fn(async () => audits),
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
const config = { projectConfig: { http: { jwtSecret: 'test-secret' } } };
const container = {
  resolve: (k: string) =>
    k === 'customer' ? customers : k === 'configModule' ? config : packs,
} as never;
const admin = { userId: 'user_1', superAdmin: true, can: async () => true };
const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;
const run = (
  name: string,
  args: Record<string, unknown>,
  userText: string,
  askedBefore?: string,
) => {
  const propose = jest.fn();
  return {
    propose,
    done: tool(name).run(args, {
      container,
      access: admin,
      userText,
      askedBefore,
      propose,
    } as never),
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  banned = ['cus_y1'];
  realName = 'Tan Ah Kow';
  metadata = {};
  audits = [];
  packs.findCustomerIdByUsername.mockImplementation(async (n: string) =>
    n.toLowerCase() === 'test player' ? 'cus_x' : null,
  );
  packs.findCustomerIdByHandle.mockImplementation(async (n: string) =>
    n.toLowerCase() === 'test_handle' ? 'cus_x' : null,
  );
  packs.payoutAccountsOf.mockResolvedValue([
    { account_key: KEY, bank_code: 'MBBEMYKL', wallet: false },
  ]);
  packs.payoutAccountHoldersAt.mockResolvedValue(['cus_y1']);
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
    expect(namedIn('please', 'Lee')).toBe(false);
    expect(namedIn('anything', '')).toBe(false);
  });
});

describe('namedPlayer: a change names one player only', () => {
  // Shown names can be ordinary words of the request.
  const players: Record<string, string> = {
    maybank: 'cus_m',
    collector123: 'cus_c',
    unban: 'cus_u',
  };
  const lookups = {
    findCustomerIdByUsername: jest.fn(
      async (n: string) => players[n.toLowerCase()] ?? null,
    ),
    findCustomerIdByHandle: jest.fn(async (n: string) =>
      n.toLowerCase() === 'c123' ? 'cus_c' : null,
    ),
  };
  const text = 'unban Maybank 2135 for Collector123';

  it('refuses any player when another word of the message is a different one', async () => {
    for (const name of ['Maybank', 'unban', 'Collector123']) {
      await expect(
        namedPlayer(lookups, name, text, 'Nothing was changed.'),
      ).rejects.toThrow(/another player too.*@handle\. Nothing was changed\./);
    }
  });

  it('acts when the other words are no one or the same player, or staff wrote @handle', async () => {
    await expect(
      namedPlayer(
        lookups,
        'Collector123',
        'free 2135 for Collector123, @c123',
        'x',
      ),
    ).resolves.toBe('cus_c');
    await expect(
      namedPlayer(lookups, 'c123', `${text} @c123`, 'x'),
    ).resolves.toBe('cus_c');
  });

  it('a read may still name anyone; a message too long to check asks for the handle', async () => {
    await expect(
      namedPlayer(lookups, 'Maybank', text, 'x', { readOnly: true }),
    ).resolves.toBe('cus_m');
    const long = `free for Collector123 ${Array.from({ length: 41 }, (_, i) => `word${i}`).join(' ')}`;
    await expect(
      namedPlayer(lookups, 'Collector123', long, 'x'),
    ).rejects.toThrow(/too long.*@handle/);
  });
});

describe('who the person named', () => {
  it("unban_account takes the banned one when a shown name is another player's handle", async () => {
    packs.findCustomerIdByUsername.mockImplementation(async (n: string) =>
      n.toLowerCase() === 'ringone' ? 'cus_y2' : null,
    );
    packs.findCustomerIdByHandle.mockImplementation(async (n: string) =>
      n.toLowerCase() === 'ringone' ? 'cus_y1' : null,
    );
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

  it('"@name" means the handle; with no such handle, it is just the name', async () => {
    packs.findCustomerIdByUsername.mockResolvedValue('cus_y2');
    packs.findCustomerIdByHandle.mockResolvedValue('cus_y1');
    banned = ['cus_y1', 'cus_y2'];
    const handle = run(
      'unban_account',
      { username: 'RingOne' },
      'unban @RingOne',
    );
    await handle.done;
    expect(handle.propose.mock.calls[0][0]).toMatchObject({
      customer_id: 'cus_y1',
    });
    packs.findCustomerIdByHandle.mockResolvedValue(null);
    const name = run(
      'unban_account',
      { username: 'RingOne' },
      'unban @RingOne',
    );
    await name.done;
    expect(name.propose.mock.calls[0][0]).toMatchObject({
      customer_id: 'cus_y2',
    });
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
    const raw = await run(
      'bank_save_check',
      { username: 'Test Player', last4: '0001' },
      'why can Test Player not add Maybank 0001',
    ).done;
    expect(raw).not.toContain(KEY);
    expect(raw).not.toMatch(/tan ah kow/i);
    const out = JSON.parse(raw);
    expect(packs.payoutAccountHoldersAt).toHaveBeenCalledWith(
      'cus_x',
      KEY,
      'MBBEMYKL',
    );
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
      name: { checked: 'the real name on file', blocks_save: true },
    });
    const fixes = out.fixes.join(' ');
    expect(fixes).toMatch(/unban_bank_number/);
    expect(fixes).toMatch(/free_bank_number/);
    expect(fixes).toMatch(
      /Freeing the number may free it too.*clear_name_clash/,
    );
  });

  it('asks for a PayNow mobile with and without its 65, as a save does', async () => {
    packs.payoutAccountsOf.mockResolvedValue([
      { account_key: '91234567', bank_code: 'PAYNOWSG', wallet: false },
    ]);
    packs.payoutAccountBanned.mockImplementation(
      async (n: string) => n === '6591234567',
    );
    packs.payoutAccountHoldersAt.mockImplementation(
      async (_id: string, n: string) => (n === '6591234567' ? ['cus_y1'] : []),
    );
    const out = JSON.parse(
      await run(
        'bank_save_check',
        { username: 'Test Player', last4: '4567' },
        'why can Test Player not add PayNow 4567',
      ).done,
    );
    expect(out.number).toMatchObject({
      banned_for_this_player: true,
      other_accounts: ['RingOne, banned'],
      blocks_save: true,
    });
  });

  it('says can_save when nothing blocks, and null when a part is unchecked', async () => {
    packs.payoutAccountHoldersAt.mockResolvedValue([]);
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
    expect(out).toMatchObject({ can_save: true, fixes: [], unchecked: [] });
    const noNumber = JSON.parse(
      await run(
        'bank_save_check',
        { username: 'Test Player' },
        'check Test Player',
      ).done,
    );
    expect(noNumber.can_save).toBeNull();
  });

  it('a number it cannot find leaves the name checked, and the bank unknown is said', async () => {
    packs.payoutAccountsOf.mockResolvedValue([]);
    packs.resolveBannedPayoutAccount.mockRejectedValue(new Error('none'));
    const out = JSON.parse(
      await run(
        'bank_save_check',
        { username: 'Test Player', last4: '9999' },
        'check Test Player 9999',
      ).done,
    );
    expect(out.number.not_checked).toMatch(/No bank number ending 9999/);
    expect(out.name.blocks_save).toBe(true);
    expect(out.can_save).toBe(false);

    const typed = JSON.parse(
      await run(
        'bank_save_check',
        { username: 'Test Player', bank_account: '7777 8888 9999' },
        'check Test Player 777788889999',
      ).done,
    );
    expect(typed.number).toMatchObject({ not_checked: 'which bank it is at' });
  });

  it('checks the number as typed against the bank rules', async () => {
    packs.payoutAccountHoldersAt.mockResolvedValue([]);
    packs.holderNameHolders.mockResolvedValue([]);
    const out = JSON.parse(
      await run(
        'bank_save_check',
        { username: 'Test Player', bank: 'Maybank', bank_account: '51234' },
        'check Test Player Maybank 51234',
      ).done,
    );
    expect(out.fixes.join(' ')).toMatch(/would be refused/);
  });

  it('an admin-only fix says so to the Support viewer', async () => {
    const support = {
      userId: 'user_2',
      superAdmin: false,
      can: async (n: unknown) => n !== BAN_LIST_NEED,
    };
    const out = JSON.parse(
      await tool('bank_save_check').run(
        { username: 'Test Player', last4: '0001' },
        { container, access: support, userText: 'check Test Player 0001' },
      ),
    );
    expect(out.fixes.join(' ')).toMatch(/Only an admin can do this/);
  });
});

describe('free_bank_number', () => {
  it('is for admins, never a scheduled run', () => {
    expect(tool('free_bank_number').needs).toEqual([UNBAN_NEED, BAN_LIST_NEED]);
    expect(scheduledRunAllows(tool('free_bank_number'))).toBe(false);
  });

  it('proposes freeing it from every other account at that bank, by fingerprint', async () => {
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
      number_mark: numberMark(KEY, container),
      from: ['cus_y1'],
      reason: 'owner approved',
    });
    expect(JSON.stringify(proposal)).not.toContain(KEY);
    expect(summary).toMatch(/RingOne, banned.*cannot be undone/);
    expect(packs.freePayoutAccount).not.toHaveBeenCalled();
  });

  it('refuses what the person did not name', async () => {
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', last4: '0001' },
        'free it',
      ).done,
    ).rejects.toThrow(/named in this message/);
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', last4: '0001' },
        'free it for Test Player',
      ).done,
    ).rejects.toThrow(/last 4 the person typed/);
    // A junk full number does not skip the last 4 check.
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', last4: '0001', bank_account: 'none' },
        'free it for Test Player',
      ).done,
    ).rejects.toThrow(/full bank number, or left out/);
  });

  it('a "yes" reply works when the message before named it', async () => {
    const { propose, done } = run(
      'free_bank_number',
      { username: 'Test Player', last4: '0001' },
      'yes',
      'let Test Player add Maybank 0001',
    );
    await done;
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it('takes a full number only as typed, even right after a name ending in digits', async () => {
    const { propose, done } = run(
      'free_bank_number',
      { username: 'Test Player', bank_account: '5123 4567 0001' },
      'Test Player Abc777 5123-4567-0001 Maybank',
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

  it('asks the bank when it is not known, and refuses a number nobody else holds', async () => {
    packs.payoutAccountsOf.mockResolvedValue([]);
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', bank_account: '512345670001' },
        'free 512345670001 for Test Player',
      ).done,
    ).rejects.toThrow(/Which bank/);
    packs.payoutAccountsOf.mockResolvedValue([
      { account_key: KEY, bank_code: 'MBBEMYKL', wallet: false },
    ]);
    packs.payoutAccountHoldersAt.mockResolvedValue([]);
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', last4: '0001' },
        'free 0001 for Test Player',
      ).done,
    ).rejects.toThrow(/nothing to free/);
  });

  it('ignores a bank the model sent that staff never typed', async () => {
    const { propose, done } = run(
      'free_bank_number',
      { username: 'Test Player', last4: '0001', bank: 'CIMB' },
      'free 0001 for Test Player',
    );
    await done;
    expect(packs.payoutAccountHoldersAt).toHaveBeenCalledWith(
      'cus_x',
      KEY,
      'MBBEMYKL',
    );
    expect(propose.mock.calls[0][0]).toMatchObject({ bank_code: 'MBBEMYKL' });
  });

  it('does not join the end of one message to the start of the other', async () => {
    await expect(
      run(
        'free_bank_number',
        { username: 'Test Player', bank_account: '512345670001' },
        '670001 for Test Player Maybank',
        'free 512345',
      ).done,
    ).rejects.toThrow(/as the person typed it/);
  });

  it('a banned player gets the card, which says to tap Unban first', async () => {
    banned = ['cus_x', 'cus_y1'];
    const { propose, done } = run(
      'free_bank_number',
      { username: 'Test Player', last4: '0001' },
      'free 0001 for Test Player',
    );
    await done;
    expect(propose.mock.calls[0][1]).toMatch(/^Tap Unban first/);
  });

  it('keeps a bank number out of the audit reason', async () => {
    const { propose, done } = run(
      'free_bank_number',
      {
        username: 'Test Player',
        last4: '0001',
        reason: 'owner ok, paid to 5123 4567 0001',
      },
      'free 0001 for Test Player, owner ok, paid to 5123 4567 0001',
    );
    await done;
    expect(propose.mock.calls[0][0].reason).toBe('owner ok, paid to [number]');
  });
});

describe('clear_name_clash', () => {
  it('is for admins, never a scheduled run', () => {
    expect(tool('clear_name_clash').needs).toEqual([UNBAN_NEED, BAN_LIST_NEED]);
    expect(scheduledRunAllows(tool('clear_name_clash'))).toBe(false);
  });

  it('lists every other account on the name, any number of them, the name masked', async () => {
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
    expect(summary).toMatch(/\(T\*\* A\* K\*\*\)/);
    expect(summary).toMatch(
      /2 other accounts use it: RingOne, banned; OpenTwo, open/,
    );
    expect(summary).not.toMatch(/tan ah kow/i);
  });

  it('prefers the name on their saved bank over the real name', async () => {
    metadata = {
      bank_accounts: [
        {
          id: 'b1',
          bankCode: 'MBBEMYKL',
          bankName: 'Maybank',
          accountNumber: '998877665544',
          accountHolderName: 'Lim Ah Lian',
          savedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const { propose, done } = run(
      'clear_name_clash',
      { username: 'Test Player' },
      'clear the name for Test Player',
    );
    await done;
    expect(propose.mock.calls[0][0]).toMatchObject({
      holder_name: 'Lim Ah Lian',
    });
  });

  it('takes a typed name only as a whole phrase the person typed', async () => {
    await expect(
      run(
        'clear_name_clash',
        { username: 'Test Player', holder_name: 'Lee' },
        'please clear the name for Test Player',
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
    number_mark: numberMark(KEY, container),
    from: ['cus_y1'],
    reason: 'owner approved',
    proposed_at: '2026-11-09T10:00:00.000Z',
  };
  const NAME: Proposal = {
    kind: 'name_clash',
    customer_id: 'cus_x',
    username: 'Test Player',
    holder_name: 'Tan Ah Kow',
    with: ['cus_y1', 'cus_y2'],
    reason: 'different people',
    proposed_at: '2026-11-09T10:00:00.000Z',
  };

  it('frees exactly the number the card was made for, as the person who tapped', async () => {
    packs.payoutAccountsOf.mockResolvedValue([
      { account_key: '999990001', bank_code: 'MBBEMYKL', wallet: false },
      { account_key: KEY, bank_code: 'MBBEMYKL', wallet: false },
    ]);
    await expect(saveProposal(FREE, admin, container)).resolves.toEqual({
      id: 'cus_x',
    });
    expect(packs.payoutAccountsOf).toHaveBeenCalledWith('cus_y1');
    expect(packs.freePayoutAccount).toHaveBeenCalledWith({
      customerId: 'cus_x',
      adminId: 'user_1',
      accountKey: KEY,
      bankCode: 'MBBEMYKL',
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

  it('refuses a role that is not an admin now, or a player still banned', async () => {
    const support = {
      ...admin,
      superAdmin: false,
      can: async (n: unknown) => n === UNBAN_NEED,
    };
    await expect(saveProposal(FREE, support, container)).rejects.toBeInstanceOf(
      ConfirmRefused,
    );
    banned = ['cus_x'];
    await expect(saveProposal(NAME, admin, container)).rejects.toThrow(
      /tap Unban first/,
    );
    expect(packs.freePayoutAccount).not.toHaveBeenCalled();
    expect(packs.setHolderNameCleared).not.toHaveBeenCalled();
  });

  // Security audit 2026-11-09: a take-back leaves no stamp, so an old button
  // would clear the name again; the audit since the card was made tells.
  it('an old button is refused once its own change was audited since', async () => {
    await saveProposal(NAME, admin, container);
    // A colleague took the clearing back (the name keyed as saves key it).
    audits = [{ after: { holder_name: 'TAN AH KOW', cleared: false, with: [] } }];
    await expect(saveProposal(NAME, admin, container)).rejects.toThrow(
      /since it was proposed/,
    );
    expect(packs.setHolderNameCleared).toHaveBeenCalledTimes(1);
    // Another name's clearing leaves the number card alone; its own free
    // refuses it.
    audits = [{ after: { holder_name: 'Someone Else', cleared: true } }];
    await saveProposal(FREE, admin, container);
    audits = [
      { after: { bank_code: 'MBBEMYKL', account_last4: '0001', held_by: [] } },
    ];
    await expect(saveProposal(FREE, admin, container)).rejects.toThrow(
      /since it was proposed/,
    );
    expect(packs.freePayoutAccount).toHaveBeenCalledTimes(1);
  });

  it('a changed account, a payout on its way or a second tap reads as refused', async () => {
    packs.payoutAccountsOf.mockResolvedValue([
      { account_key: '999990001', bank_code: 'MBBEMYKL', wallet: false },
    ]);
    await expect(saveProposal(FREE, admin, container)).rejects.toThrow(
      /no longer hold that number/,
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
