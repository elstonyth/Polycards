import { MedusaError } from '@medusajs/framework/utils';
import { AGENT_TOOLS } from '../agent-tools';
import {
  ConfirmRefused,
  saveProposal,
  UNBAN_NEED,
  type Proposal,
} from '../confirm';

// Unbanning a bank number through the assistant (owner, 2026-11-04): the model
// only proposes, for a number the person named by its last 4 on a player they
// named; the tap lifts it through liftPayoutAccountBan. Made-up details only.

jest.mock('../../../utils/image-fetch', () => ({ fetchImage: jest.fn() }));

const packs = {
  findCustomerIdByUsername: jest.fn(),
  findCustomerIdByHandle: jest.fn(),
  bannedPayoutAccountsOf: jest.fn(),
  liftPayoutAccountBan: jest.fn(),
};
const container = { resolve: () => packs } as never;
const admin = { userId: 'user_1', superAdmin: true };
const tool = AGENT_TOOLS.find((t) => t.name === 'unban_bank_number')!;
const run = (args: Record<string, unknown>, userText: string) => {
  const propose = jest.fn();
  return {
    propose,
    done: tool.run(args, { container, access: admin, userText, propose }),
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  packs.findCustomerIdByUsername.mockResolvedValue('cus_1');
  packs.findCustomerIdByHandle.mockResolvedValue(null);
  packs.bannedPayoutAccountsOf.mockResolvedValue([
    { account_key: '512345670001', bank_code: 'MBBEMYKL', last4: '0001' },
    { account_key: '512345670002', bank_code: 'PBBEMYKL', last4: '0002' },
  ]);
  packs.liftPayoutAccountBan.mockResolvedValue({
    bank_code: 'MBBEMYKL',
    last4: '0001',
  });
});

describe('unban_bank_number', () => {
  it('needs the unban policy, which the Support viewer holds', () => {
    expect(tool.needs).toEqual([UNBAN_NEED]);
  });

  it('proposes taking a named number off the ban list, with no full number', async () => {
    const { propose, done } = run(
      { username: 'TestPlayer', last4: '0001', reason: 'owner approved' },
      'unban Maybank 0001 on TestPlayer, owner approved',
    );
    expect(JSON.parse(await done)).toMatchObject({ unbanned: false });
    expect(propose).toHaveBeenCalledWith(
      {
        kind: 'unban_number',
        customer_id: 'cus_1',
        username: 'TestPlayer',
        bank_code: 'MBBEMYKL',
        last4: '0001',
        reason: 'owner approved',
      },
      expect.stringMatching(
        /^Take Maybank …0001 \(on TestPlayer\) off the ban list/,
      ),
    );
    expect(JSON.stringify(propose.mock.calls)).not.toContain('512345670001');
    expect(packs.liftPayoutAccountBan).not.toHaveBeenCalled();
  });

  it('refuses digits or a player the person did not name in this message', async () => {
    await expect(
      run({ username: 'TestPlayer', last4: '0001' }, 'unban TestPlayer').done,
    ).rejects.toThrow(/named in this message/);
    await expect(
      run({ username: 'TestPlayer', last4: '0001' }, 'unban number 0001').done,
    ).rejects.toThrow(/named in this message/);
  });

  it('refuses a number not banned on that player, and asks for the bank when two match', async () => {
    await expect(
      run({ username: 'TestPlayer', last4: '9999' }, 'unban 9999 on TestPlayer')
        .done,
    ).rejects.toThrow(/no banned bank number ending 9999/);
    packs.bannedPayoutAccountsOf.mockResolvedValue([
      { account_key: '1111110001', bank_code: 'MBBEMYKL', last4: '0001' },
      { account_key: '2222220001', bank_code: 'PBBEMYKL', last4: '0001' },
    ]);
    await expect(
      run({ username: 'TestPlayer', last4: '0001' }, 'unban 0001 on TestPlayer')
        .done,
    ).rejects.toThrow(/which bank/);
    const { propose, done } = run(
      { username: 'TestPlayer', last4: '0001', bank: 'Public Bank' },
      'unban Public Bank 0001 on TestPlayer',
    );
    await done;
    expect(propose.mock.calls[0][0]).toMatchObject({ bank_code: 'PBBEMYKL' });
  });
});

describe('saveProposal unban_number', () => {
  const NUMBER: Proposal = {
    kind: 'unban_number',
    customer_id: 'cus_1',
    username: 'TestPlayer',
    bank_code: 'MBBEMYKL',
    last4: '0001',
    reason: 'owner approved',
  };

  it('lifts it as the person who tapped, when their role still may', async () => {
    const can = jest.fn().mockResolvedValue(true);
    await expect(
      saveProposal(NUMBER, { ...admin, can }, container),
    ).resolves.toEqual({ id: 'cus_1' });
    expect(can).toHaveBeenCalledWith(UNBAN_NEED);
    expect(packs.liftPayoutAccountBan).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      last4: '0001',
      bankCode: 'MBBEMYKL',
      reason: 'owner approved',
    });
  });

  it('refuses without the role, and a second tap reads as refused', async () => {
    await expect(
      saveProposal(
        NUMBER,
        { ...admin, can: jest.fn().mockResolvedValue(false) },
        container,
      ),
    ).rejects.toBeInstanceOf(ConfirmRefused);
    expect(packs.liftPayoutAccountBan).not.toHaveBeenCalled();
    packs.liftPayoutAccountBan.mockRejectedValue(
      new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'No banned bank number ending 0001 on this player.',
      ),
    );
    await expect(
      saveProposal(
        NUMBER,
        { ...admin, can: jest.fn().mockResolvedValue(true) },
        container,
      ),
    ).rejects.toBeInstanceOf(ConfirmRefused);
  });
});
