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

// Every stored order carries its address snapshot (the ship_* columns are NOT
// NULL); the zone guard reads it to price the edit.
const order = (over: Record<string, unknown> = {}) => ({
  id: 'do_1',
  customer_id: 'cus_1',
  status: 'requested',
  ship_city: 'Kuala Lumpur',
  ship_province: null,
  ship_postal_code: '50000',
  ship_country_code: 'my',
  shipping_fee: null,
  ...over,
});

const updateDeliveryOrders = jest.fn();

const mkReq = (orders: any[], customerId = 'cus_1', address = ADDRESS) => ({
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
            listCustomerAddresses: jest.fn(async () => [address]),
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

  // The zone guard: an order that paid a fee keeps its zone; one that paid
  // none (pre-fee orders, prizes before 2026-10-14) may move to the same or a
  // cheaper zone, never a dearer one.
  const SG_ADDRESS = {
    ...ADDRESS,
    city: 'Singapore',
    postal_code: '018983',
    country_code: 'sg',
  };

  it('lets an unpaid East order move to a cheaper West address', async () => {
    const east = order({ ship_city: 'Kota Kinabalu', ship_postal_code: '88000' });
    await editAddress(mkReq([east]) as any, mkRes().res);
    expect(updateDeliveryOrders).toHaveBeenCalledTimes(1);
  });

  it('refuses to move an unpaid West order to dearer Singapore', async () => {
    await expect(
      editAddress(mkReq([order()], 'cus_1', SG_ADDRESS) as any, mkRes().res),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/changes the shipping fee zone/),
    });
    expect(updateDeliveryOrders).not.toHaveBeenCalled();
  });

  it('after the 12am cutoff, the zone refusal sends the customer to support, not to cancel', async () => {
    await expect(
      editAddress(
        mkReq([order({ status: 'processed' })], 'cus_1', SG_ADDRESS) as any,
        mkRes().res,
      ),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(
        /changes the shipping fee zone, which can no longer change .*contact support/,
      ),
    });
    expect(updateDeliveryOrders).not.toHaveBeenCalled();
  });

  it('refuses any zone change on an order that paid a fee', async () => {
    const paidEast = order({
      ship_city: 'Kota Kinabalu',
      ship_postal_code: '88000',
      shipping_fee: 35,
    });
    await expect(
      editAddress(mkReq([paidEast]) as any, mkRes().res),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
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
