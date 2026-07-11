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

test('adjustCredits posts amount + note to the customer credits route', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  await c.adjustCredits('cus_1', -25, 'refund: pack DOA');
  assert.equal(calls[0].url, 'http://h/admin/customers/cus_1/credits');
  assert.equal(calls[0].opts.headers['Authorization'], 'Bearer adm');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    amount: -25,
    note: 'refund: pack DOA',
  });
});

test('freeze hits the freeze sub-route', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  await c.freeze('cus_2', 'chargeback');
  assert.equal(calls[0].url, 'http://h/admin/customers/cus_2/freeze');
  assert.equal(calls[0].opts.method, 'POST');
});

test('unfreeze sends the required reason (the route 400s on an empty body)', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  await c.unfreeze('cus_5', 'dispute resolved');
  assert.equal(calls[0].url, 'http://h/admin/customers/cus_5/unfreeze');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    reason: 'dispute resolved',
  });
});

test('admin client sends no publishable key header', async () => {
  const { fetchImpl, calls } = recorder({ items: [], total: 0 });
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  await c.getCustomerTransactions('cus_3');
  assert.equal(calls[0].opts.headers['x-publishable-api-key'], undefined);
});

test('getCustomerTransactions pages through ALL rows (not just the first page)', async () => {
  // total 150: first page 100, second page 50 — the bug summed only the first.
  const fetchImpl = async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    const n = offset < 100 ? 100 : 50;
    const items = Array.from({ length: n }, (_, i) => ({
      id: 'tx' + (offset + i),
      amount: 1,
    }));
    return { status: 200, json: async () => ({ total: 150, items }) };
  };
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  const r = await c.getCustomerTransactions('cus_4');
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 150);
  assert.equal(r.body.total, 150);
});
