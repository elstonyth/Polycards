jest.mock('@medusajs/framework/workflows-sdk', () => ({
  createStep: (_name: string, invoke: unknown) => invoke,
  StepResponse: class {
    constructor(public output: unknown) {}
  },
}));
jest.mock('../../../modules/packs', () => ({ PACKS_MODULE: 'packs' }));
import { chargePackOpenStep } from '../charge-pack-open';

const invoke = chargePackOpenStep as unknown as (
  input: Record<string, unknown>,
  context: { container: { resolve: () => unknown } },
) => Promise<unknown>;

describe('live draw spend limit at the charge seam', () => {
  it('refuses a price increase before any money is charged', async () => {
    const settleOpen = jest.fn();
    await expect(
      invoke(
        {
          pack_id: 'pack',
          customer_id: 'cus_1',
          open_id: 'open_1',
          max_price: 10,
        },
        {
          container: {
            resolve: () => ({
              listPacks: async () => [
                {
                  price: 20,
                  status: 'active',
                  in_stock: true,
                  category: 'pokemon',
                },
              ],
              settleOpen,
            }),
          },
        },
      ),
    ).rejects.toThrow('limit');
    expect(settleOpen).not.toHaveBeenCalled();
  });

  it('keeps ordinary opens unchanged and accepts a price within the limit', async () => {
    for (const max_price of [undefined, 10]) {
      const settleOpen = jest.fn(async () => ({
        balance: 10,
        bonusCents: 500,
      }));
      await invoke(
        { pack_id: 'pack', customer_id: 'cus_1', open_id: 'open_1', max_price },
        {
          container: {
            resolve: () => ({
              listPacks: async () => [
                {
                  price: 10,
                  status: 'active',
                  in_stock: true,
                  category: 'pokemon',
                },
              ],
              settleOpen,
            }),
          },
        },
      );
      expect(settleOpen).toHaveBeenCalledWith({
        customerId: 'cus_1',
        amount: -10,
        sourceTransactionId: 'open_1',
      });
    }
  });
});
