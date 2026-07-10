import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAdminClient } from './admin-client.mjs';

function recorder(status = 200, body = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, opts) => (
      calls.push({ url, opts }),
      { status, json: async () => body }
    ),
  };
}

test('adjustCredits posts amount + reason to the customer credits route', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  await c.adjustCredits('cus_1', -25, 'refund: pack DOA');
  assert.equal(calls[0].url, 'http://h/admin/customers/cus_1/credits');
  assert.equal(calls[0].opts.headers['Authorization'], 'Bearer adm');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    amount: -25,
    reason: 'refund: pack DOA',
  });
});

test('freeze hits the freeze sub-route', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  await c.freeze('cus_2', 'chargeback');
  assert.equal(calls[0].url, 'http://h/admin/customers/cus_2/freeze');
  assert.equal(calls[0].opts.method, 'POST');
});

test('admin client sends no publishable key header', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  await c.getCustomerTransactions('cus_3');
  assert.equal(calls[0].opts.headers['x-publishable-api-key'], undefined);
});
