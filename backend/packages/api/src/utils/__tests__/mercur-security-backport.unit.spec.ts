import type { MedusaContainer } from '@medusajs/framework';
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { linkCustomersToCustomerGroupWorkflow } from '@medusajs/core-flows';
import { StoreAddCartLineItem } from '@mercurjs/core/api/store/carts/[id]/line-items/validators';
import { vendorProductsMiddlewares } from '@mercurjs/core/api/vendor/products/middlewares';
import { validateSellerCustomer } from '@mercurjs/core/api/vendor/customers/helpers';
import { POST } from '@mercurjs/core/api/vendor/customer-groups/[id]/customers/route';

// Only the database and mutation workflow are stubbed; patched exports execute.
jest.mock('@medusajs/core-flows', () => ({
  linkCustomersToCustomerGroupWorkflow: jest.fn(),
}));

const graph = jest.fn();
const scope = {
  resolve: jest.fn(() => ({ graph })),
} as unknown as MedusaContainer;
const run = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  graph.mockReset();
  run.mockResolvedValue({});
  jest
    .mocked(linkCustomersToCustomerGroupWorkflow)
    .mockReturnValue({ run } as unknown as ReturnType<
      typeof linkCustomersToCustomerGroupWorkflow
    >);
});

describe('Mercur 2.3.5 security fixes backported to 2.3.3', () => {
  it.each(['unit_price', 'compare_at_unit_price'])(
    'rejects client %s, including zero',
    (field) => {
      const item = { offer_id: 'offer_1', quantity: 1 };
      expect(StoreAddCartLineItem.safeParse(item).success).toBe(true);
      for (const price of [0, 1]) {
        expect(
          StoreAddCartLineItem.safeParse({ ...item, [field]: price }).success,
        ).toBe(false);
      }
    },
  );

  it.each(['POST', 'DELETE'] as const)(
    'guards %s variants against the path product',
    async (method) => {
      const guard = vendorProductsMiddlewares.find(
        (route) =>
          route.matcher === '/vendor/products/:id/variants/:variant_id' &&
          (Array.isArray(route.method)
            ? route.method.includes(method)
            : route.method === method),
      )?.middlewares?.[0];
      expect(guard).toBeDefined();
      const req = {
        scope,
        params: { id: 'prod_own', variant_id: 'var_1' },
      } as unknown as MedusaRequest;
      const next = jest.fn();
      graph.mockResolvedValueOnce({ data: [] });
      await expect(
        guard!(req, {} as MedusaResponse, next),
      ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
      expect(graph).toHaveBeenCalledWith({
        entity: 'variant',
        fields: ['id'],
        filters: { id: 'var_1', product_id: 'prod_own' },
      });
      expect(next).not.toHaveBeenCalled();
      graph.mockResolvedValueOnce({ data: [{ id: 'var_1' }] });
      await guard!(req, {} as MedusaResponse, next);
      expect(next).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps scalar customer callers and empty lists valid, but rejects mixed ownership', async () => {
    await validateSellerCustomer(scope, 'seller_1', []);
    expect(scope.resolve).not.toHaveBeenCalled();
    graph.mockResolvedValue({ data: [{ customer_id: 'cus_owned' }] });
    await validateSellerCustomer(scope, 'seller_1', 'cus_owned');
    expect(graph).toHaveBeenCalledWith({
      entity: 'seller_customer',
      fields: ['customer_id'],
      filters: { seller_id: 'seller_1', customer_id: ['cus_owned'] },
    });
    await expect(
      validateSellerCustomer(scope, 'seller_1', ['cus_owned', 'cus_other']),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
      message: 'Customer with id: cus_other was not found',
    });
  });

  it.each(['add', 'remove'] as const)(
    'validates every %s customer before invoking the mutation workflow',
    async (operation) => {
      graph
        .mockResolvedValueOnce({ data: [{ customer_group_id: 'cg_1' }] })
        .mockResolvedValueOnce({ data: [{ customer_id: 'cus_owned' }] });
      const req = {
        scope,
        params: { id: 'cg_1' },
        seller_context: { seller_id: 'seller_1' },
        validatedBody: { [operation]: ['cus_owned', 'cus_other'] },
        queryConfig: { fields: ['id'] },
      } as unknown as Parameters<typeof POST>[0];
      await expect(
        POST(req, {} as Parameters<typeof POST>[1]),
      ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
      expect(graph).toHaveBeenNthCalledWith(2, {
        entity: 'seller_customer',
        fields: ['customer_id'],
        filters: {
          seller_id: 'seller_1',
          customer_id: ['cus_owned', 'cus_other'],
        },
      });
      expect(linkCustomersToCustomerGroupWorkflow).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('validates add and remove together before forwarding a valid membership update', async () => {
    graph
      .mockResolvedValueOnce({ data: [{ customer_group_id: 'cg_1' }] })
      .mockResolvedValueOnce({
        data: [{ customer_id: 'cus_add' }, { customer_id: 'cus_remove' }],
      })
      .mockResolvedValueOnce({ data: [{ id: 'cg_1' }] });
    const req = {
      scope,
      params: { id: 'cg_1' },
      seller_context: { seller_id: 'seller_1' },
      validatedBody: { add: ['cus_add'], remove: ['cus_remove'] },
      queryConfig: { fields: ['id'] },
    } as unknown as Parameters<typeof POST>[0];
    const res = { json: jest.fn() } as unknown as Parameters<typeof POST>[1];
    await POST(req, res);
    expect(graph).toHaveBeenNthCalledWith(2, {
      entity: 'seller_customer',
      fields: ['customer_id'],
      filters: {
        seller_id: 'seller_1',
        customer_id: ['cus_add', 'cus_remove'],
      },
    });
    expect(run).toHaveBeenCalledWith({
      input: { id: 'cg_1', add: ['cus_add'], remove: ['cus_remove'] },
    });
    expect(graph.mock.invocationCallOrder[1]).toBeLessThan(
      run.mock.invocationCallOrder[0],
    );
    expect(res.json).toHaveBeenCalledWith({ customer_group: { id: 'cg_1' } });
  });
});
