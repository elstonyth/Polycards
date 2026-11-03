import { MedusaError } from '@medusajs/framework/utils';
import { AGENT_TOOLS } from '../agent-tools';
import {
  ConfirmRefused,
  saveProposal,
  UNBAN_NEED,
  type Proposal,
} from '../confirm';

// Unbanning through the assistant (owner, 2026-11-03): the model only proposes,
// for a player the person named in this message who holds a permanent ban; the
// tap lifts it through liftPermanentBan, which clears the saved banks.

jest.mock('../../../utils/image-fetch', () => ({ fetchImage: jest.fn() }));

const BAN =
  'Permanent ban: shared bank account, more than one account (owner, 2026-11-03)';
const packs = {
  findCustomerIdByUsername: jest.fn(),
  findCustomerIdByHandle: jest.fn(),
  listCustomerAccountStates: jest.fn(),
  liftPermanentBan: jest.fn(),
};
const container = { resolve: () => packs } as never;
const admin = { userId: 'user_1', superAdmin: true };
const unban = AGENT_TOOLS.find((t) => t.name === 'unban_account')!;

beforeEach(() => {
  jest.clearAllMocks();
  packs.findCustomerIdByUsername.mockResolvedValue('cus_1');
  packs.findCustomerIdByHandle.mockResolvedValue(null);
  packs.listCustomerAccountStates.mockResolvedValue([{ disabled_reason: BAN }]);
  packs.liftPermanentBan.mockResolvedValue({ cleared: 2 });
});

describe('unban_account', () => {
  it('needs its own policy, which the Support viewer holds', () => {
    expect(unban.needs).toEqual([UNBAN_NEED]);
    expect(UNBAN_NEED).toEqual({
      resource: 'assistant_unban',
      operation: 'update',
    });
  });

  it('proposes an unban for a permanently banned player named in the message', async () => {
    const propose = jest.fn();
    const out = await unban.run(
      { username: 'Collector6903', reason: 'owner approved' },
      {
        container,
        access: admin,
        userText: 'please unban collector6903',
        propose,
      },
    );
    expect(propose).toHaveBeenCalledWith(
      {
        kind: 'unban',
        customer_id: 'cus_1',
        username: 'Collector6903',
        reason: 'owner approved',
      },
      expect.stringContaining('link a bank again'),
    );
    expect(JSON.parse(out)).toMatchObject({ unbanned: false });
    expect(packs.liftPermanentBan).not.toHaveBeenCalled();
  });

  it('refuses a player the person did not name in this message', async () => {
    const propose = jest.fn();
    await expect(
      unban.run(
        { username: 'Collector6903' },
        {
          container,
          access: admin,
          userText: 'unban the one in that note',
          propose,
        },
      ),
    ).rejects.toThrow(/named in this message/);
    expect(propose).not.toHaveBeenCalled();
  });

  it('refuses an account with no permanent ban (staff disable, deleted)', async () => {
    packs.listCustomerAccountStates.mockResolvedValue([
      { disabled_reason: 'Account deleted by an operator.' },
    ]);
    await expect(
      unban.run(
        { username: 'Collector6903' },
        {
          container,
          access: admin,
          userText: 'unban Collector6903',
          propose: jest.fn(),
        },
      ),
    ).rejects.toThrow(/no permanent ban/);
  });

  it("refuses a name that is another player's handle", async () => {
    packs.findCustomerIdByHandle.mockResolvedValue('cus_2');
    await expect(
      unban.run(
        { username: 'Collector6903' },
        {
          container,
          access: admin,
          userText: 'unban Collector6903',
          propose: jest.fn(),
        },
      ),
    ).rejects.toThrow(/different player/);
  });
});

describe('saveProposal unban', () => {
  const UNBAN: Proposal = {
    kind: 'unban',
    customer_id: 'cus_1',
    username: 'Collector6903',
    reason: 'owner approved',
  };

  it('lifts the ban as the person who tapped, when their role still may', async () => {
    const can = jest.fn().mockResolvedValue(true);
    await expect(
      saveProposal(UNBAN, { ...admin, can }, container),
    ).resolves.toEqual({ id: 'cus_1' });
    expect(can).toHaveBeenCalledWith(UNBAN_NEED);
    expect(packs.liftPermanentBan).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      reason: 'owner approved',
    });
  });

  it('refuses when the role no longer may, and lifts nothing', async () => {
    await expect(
      saveProposal(
        UNBAN,
        { ...admin, can: jest.fn().mockResolvedValue(false) },
        container,
      ),
    ).rejects.toBeInstanceOf(ConfirmRefused);
    await expect(saveProposal(UNBAN, admin, container)).rejects.toBeInstanceOf(
      ConfirmRefused,
    );
    expect(packs.liftPermanentBan).not.toHaveBeenCalled();
  });

  it('a second tap reads as refused, not as a server error', async () => {
    packs.liftPermanentBan.mockRejectedValue(
      new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'This account has no permanent ban to lift.',
      ),
    );
    await expect(
      saveProposal(
        UNBAN,
        { ...admin, can: jest.fn().mockResolvedValue(true) },
        container,
      ),
    ).rejects.toThrow(ConfirmRefused);
  });
});
