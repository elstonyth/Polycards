import type { MedusaContainer } from '@medusajs/framework/types';
import { MedusaError } from '@medusajs/framework/utils';
import type {
  StepExecutionContext,
  StepResponse,
} from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../../modules/packs';
import { FREE_WELCOME_CATEGORY } from '../../../modules/packs/free-pack';
import {
  chargePackBatchInvoke,
  type ChargePackBatchResult,
} from '../charge-pack-batch';

// The batch charge is the ONE place a multi-open's debit is computed. Two
// contracts live here: the debit is cent-exact (binary floats must never reach
// the ledger or the API), and the free welcome pack can never be batched —
// its claim seam lives in open-pack, so a batch would mint unclaimed pulls
// that also satisfy the "first paid open" unlock.

const buildContext = (packs: Record<string, jest.Mock>) =>
  ({
    container: {
      resolve: (key: string) => {
        if (key === PACKS_MODULE) return packs;
        throw new Error(`unit stub: unexpected container.resolve("${key}")`);
      },
    } as unknown as MedusaContainer,
  }) as unknown as StepExecutionContext;

type Invoked = StepResponse<ChargePackBatchResult, { open_id: string }>;

const INPUT = {
  pack_id: 'test-pack',
  customer_id: 'cus_1',
  count: 3,
  open_id: 'open_1',
};

describe('chargePackBatchInvoke', () => {
  it('cent-rounds price × count before debiting and echoing the total', async () => {
    const packs = {
      listPacks: jest
        .fn()
        .mockResolvedValue([
          { slug: 'test-pack', price: 149.9, category: 'pokemon' },
        ]),
      settleOpen: jest.fn().mockResolvedValue({ balance: 50.3 }),
      creditBalance: jest.fn(),
    };
    const res = (await chargePackBatchInvoke(
      INPUT,
      buildContext(packs),
    )) as Invoked;
    // 149.9 * 3 === 449.70000000000005 in binary; the ledger must see 449.7.
    expect(packs.settleOpen).toHaveBeenCalledWith({
      customerId: 'cus_1',
      amount: -449.7,
      sourceTransactionId: 'open_1',
    });
    expect(res.output).toEqual({ price: 149.9, total: 449.7, balance: 50.3 });
    expect(res.compensateInput).toEqual({ open_id: 'open_1' });
  });

  it('refuses the free welcome pack before touching the ledger', async () => {
    const packs = {
      listPacks: jest
        .fn()
        .mockResolvedValue([
          { slug: 'free', price: 0, category: FREE_WELCOME_CATEGORY },
        ]),
      settleOpen: jest.fn(),
      creditBalance: jest.fn(),
    };
    await expect(
      chargePackBatchInvoke(
        { ...INPUT, pack_id: 'free', count: 2 },
        buildContext(packs),
      ),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: 'The free welcome pack can only be opened once, singly.',
    });
    expect(packs.settleOpen).not.toHaveBeenCalled();
    expect(packs.creditBalance).not.toHaveBeenCalled();
  });
});
