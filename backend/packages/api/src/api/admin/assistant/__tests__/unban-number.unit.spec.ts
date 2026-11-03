import { MedusaError } from '@medusajs/framework/utils';
import { AGENT_TOOLS } from '../agent-tools';
import {
  ConfirmRefused,
  saveProposal,
  scheduledRunAllows,
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
  resolveBannedPayoutAccount: jest.fn(),
  setPayoutBanLifted: jest.fn(),
};
const customers = {
  listCustomers: jest.fn(async () => [
    { first_name: 'TestPlayer', metadata: { handle: 'Test_Handle' } },
  ]),
};
const container = {
  resolve: (k: string) => (k === 'customer' ? customers : packs),
} as never;
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
  packs.resolveBannedPayoutAccount.mockResolvedValue({
    account_key: '512345670001',
    bank_code: 'MBBEMYKL',
    last4: '0001',
    found_on: 'player',
  });
  packs.setPayoutBanLifted.mockResolvedValue({
    bank_code: 'MBBEMYKL',
    last4: '0001',
    lifted: true,
    changed: true,
  });
});

describe('unban_bank_number', () => {
  it('needs the unban policy, which the Support viewer holds', () => {
    expect(tool.needs).toEqual([UNBAN_NEED]);
  });

  it('proposes unbanning a named number for that player only, with no full number', async () => {
    const { propose, done } = run(
      { username: 'TestPlayer', last4: 1, reason: 'owner approved' },
      'unban Maybank 0001 for TestPlayer, owner approved',
    );
    await expect(done).rejects.toThrow(/last 4 digits/);
    const ok = run(
      { username: 'TestPlayer', last4: '0001', reason: 'owner approved' },
      'unban Maybank 0001 for TestPlayer, owner approved',
    );
    expect(JSON.parse(await ok.done)).toMatchObject({ unbanned: false });
    expect(ok.propose).toHaveBeenCalledWith(
      {
        kind: 'unban_number',
        customer_id: 'cus_1',
        username: 'TestPlayer',
        bank_code: 'MBBEMYKL',
        last4: '0001',
        reason: 'owner approved',
      },
      expect.stringMatching(
        /^Unban Maybank …0001 for TestPlayer \(@Test_Handle\) only:.*stays banned for every other account/,
      ),
    );
    expect(JSON.stringify(ok.propose.mock.calls)).not.toContain('512345670001');
    expect(packs.setPayoutBanLifted).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
  });

  it('accepts the 4 digits sent as a number', async () => {
    const { propose, done } = run(
      { username: 'TestPlayer', last4: 2135 },
      '解封 TestPlayer 的 Maybank 2135',
    );
    await done;
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it('needs the player and the 4 digits as their own words in this message, and says how to resend', async () => {
    for (const text of [
      'unban TestPlayer',
      'unban number 0001',
      'unban TestPlayer0001',
      'unban TestPlayer, phone 0123450001',
    ]) {
      await expect(
        run({ username: 'TestPlayer', last4: '0001' }, text).done,
      ).rejects.toThrow(/send it again in one message/);
    }
  });

  it('passes the bank only as a tie-break, and relays a refusal with how to resend', async () => {
    await run(
      { username: 'TestPlayer', last4: '0001', bank: 'public bank' },
      'unban public bank 0001 for TestPlayer',
    ).done;
    expect(packs.resolveBannedPayoutAccount).toHaveBeenCalledWith('cus_1', '0001', 'PBBEMYKL');
    packs.resolveBannedPayoutAccount.mockRejectedValue(
      new MedusaError(MedusaError.Types.NOT_ALLOWED, '2 banned numbers end 0001 (Maybank, Public Bank). Say which bank.'),
    );
    await expect(
      run({ username: 'TestPlayer', last4: '0001' }, 'unban 0001 for TestPlayer').done,
    ).rejects.toThrow(/Maybank, Public Bank.*send it again/);
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

  it('unbans it for the player as the person who tapped, when their role still may', async () => {
    const can = jest.fn().mockResolvedValue(true);
    await expect(
      saveProposal(NUMBER, { ...admin, can }, container),
    ).resolves.toEqual({ id: 'cus_1' });
    expect(can).toHaveBeenCalledWith(UNBAN_NEED);
    expect(packs.setPayoutBanLifted).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      last4: '0001',
      bankCode: 'MBBEMYKL',
      lifted: true,
      reason: 'owner approved',
    });
  });

  it('refuses without the role, and a refusal on tap reads as refused', async () => {
    await expect(
      saveProposal(NUMBER, { ...admin, can: jest.fn().mockResolvedValue(false) }, container),
    ).rejects.toBeInstanceOf(ConfirmRefused);
    expect(packs.setPayoutBanLifted).not.toHaveBeenCalled();
    packs.setPayoutBanLifted.mockRejectedValue(
      new MedusaError(MedusaError.Types.NOT_FOUND, 'No banned bank number ends 0001.'),
    );
    await expect(
      saveProposal(NUMBER, { ...admin, can: jest.fn().mockResolvedValue(true) }, container),
    ).rejects.toBeInstanceOf(ConfirmRefused);
  });
});

describe('scheduled runs', () => {
  it('drop every tool that needs the unban policy', () => {
    expect(scheduledRunAllows(tool)).toBe(false);
    expect(
      scheduledRunAllows(AGENT_TOOLS.find((t) => t.name === 'unban_account')!),
    ).toBe(false);
    expect(
      scheduledRunAllows({ name: 'player', needs: [{ resource: 'customer', operation: 'read' }] }),
    ).toBe(true);
  });
});
