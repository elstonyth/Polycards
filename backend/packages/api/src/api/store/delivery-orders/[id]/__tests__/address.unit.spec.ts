import { MedusaError } from '@medusajs/framework/utils';
import { POST as editAddress } from '../address/route';
import { PACKS_MODULE } from '../../../../../modules/packs';

// The route's contract: ownership, the edit window (requested|processed only),
// and CUSTOMER-FACING copy for the locked states. `snapshotAddress` is NOT
// mocked — it is pure, and the status-label map lives in the same module, so
// mocking it would hide the very thing these cases pin.

const ADDRESS = {
  id: 'addr_1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  address_1: '1 Jalan Utama',
  city: 'Kuala Lumpur',
  postal_code: '50000',
  country_code: 'my',
};

const mkRes = () => {
  const out: { body?: any } = {};
  return { res: { json: (b: any) => (out.body = b) } as any, out };
};

const order = (over: Record<string, unknown> = {}) => ({
  id: 'do_1',
  customer_id: 'cus_1',
  status: 'requested',
  ...over,
});

const updateDeliveryOrders = jest.fn();

const mkReq = (orders: any[], customerId = 'cus_1') => ({
  auth_context: { actor_id: customerId },
  params: { id: 'do_1' },
  body: { address_id: 'addr_1' },
  scope: {
    resolve: (key: string) =>
      key === PACKS_MODULE
        ? {
            listDeliveryOrders: jest.fn(async () => orders),
            updateDeliveryOrders,
          }
        : {
            listCustomerAddresses: jest.fn(async () => [ADDRESS]),
            // Profile fallback for ship_phone (addresses saved by the
            // storefront's inline form carry no phone).
            listCustomers: jest.fn(async () => [
              { id: customerId, phone: '+60107667787' },
            ]),
          },
  },
});

beforeEach(() => {
  updateDeliveryOrders.mockReset().mockResolvedValue([{ id: 'do_1' }]);
});

describe('POST /store/delivery-orders/:id/address', () => {
  it.each(['requested', 'processed', 'packing'])(
    'allows an address edit while %s',
    async (status) => {
      const { res, out } = mkRes();
      await editAddress(mkReq([order({ status })]) as any, res);
      expect(updateDeliveryOrders).toHaveBeenCalledTimes(1);
      expect(out.body.address.ship_name).toBe('Ada Lovelace');
      // Address has no phone → the profile phone rides into the snapshot.
      expect(out.body.address.ship_phone).toBe('+60107667787');
    },
  );

  it('locks the address from ready_to_ship on, in human wording', async () => {
    const err = (await editAddress(
      mkReq([order({ status: 'ready_to_ship' })]) as any,
      mkRes().res,
    ).catch((e: MedusaError) => e)) as MedusaError;

    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toMatch(/already ready to ship/i);
    // The raw enum token must never reach a customer.
    expect(err.message).not.toMatch(/ready_to_ship/);
    expect(updateDeliveryOrders).not.toHaveBeenCalled();
  });

  it("calls a completed order 'delivered' — the customer-facing wording", async () => {
    const err = (await editAddress(
      mkReq([order({ status: 'completed' })]) as any,
      mkRes().res,
    ).catch((e: MedusaError) => e)) as MedusaError;

    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toMatch(/already delivered/i);
    expect(err.message).not.toMatch(/completed/i);
    expect(updateDeliveryOrders).not.toHaveBeenCalled();
  });

  it('404s a foreign order without touching the address book', async () => {
    await expect(
      editAddress(
        mkReq([order({ customer_id: 'cus_other' })]) as any,
        mkRes().res,
      ),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
    expect(updateDeliveryOrders).not.toHaveBeenCalled();
  });
});
