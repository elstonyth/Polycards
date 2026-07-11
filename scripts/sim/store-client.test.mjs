import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStoreClient } from './store-client.mjs';

function recorder(status = 200, body = { ok: true }) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { status, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('topup sends amount, idempotency key, publishable key and bearer token', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeStoreClient({
    baseUrl: 'http://h',
    publishableKey: 'pk_1',
    token: 'tok',
    fetchImpl,
  });
  const res = await c.topup(50, 'idem-1');
  assert.equal(res.status, 200);
  const { url, opts } = calls[0];
  assert.equal(url, 'http://h/store/credits/topup');
  assert.equal(opts.headers['Idempotency-Key'], 'idem-1');
  assert.equal(opts.headers['x-publishable-api-key'], 'pk_1');
  assert.equal(opts.headers['Authorization'], 'Bearer tok');
  assert.deepEqual(JSON.parse(opts.body), { amount: 50 });
});

test('openPack targets the slug open route', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeStoreClient({
    baseUrl: 'http://h',
    publishableKey: 'pk',
    token: 't',
    fetchImpl,
  });
  await c.openPack('starter-pack');
  assert.equal(calls[0].url, 'http://h/store/packs/starter-pack/open');
  assert.equal(calls[0].opts.method, 'POST');
});

test('login returns the parsed body so the caller can read the token', async () => {
  const { fetchImpl } = recorder(200, { token: 'jwt-xyz' });
  const c = makeStoreClient({
    baseUrl: 'http://h',
    publishableKey: 'pk',
    fetchImpl,
  });
  const res = await c.login('a@b.co', 'pw');
  assert.equal(res.body.token, 'jwt-xyz');
});

test('createCustomer authorizes with the register token, not the client token, and posts email + first_name', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeStoreClient({
    baseUrl: 'http://h',
    publishableKey: 'pk',
    token: 'should-not-be-used',
    fetchImpl,
  });
  await c.createCustomer('reg-tok', { email: 'a@b.co', first_name: 'A' });
  const { url, opts } = calls[0];
  assert.equal(url, 'http://h/store/customers');
  assert.equal(opts.headers['Authorization'], 'Bearer reg-tok');
  assert.deepEqual(JSON.parse(opts.body), { email: 'a@b.co', first_name: 'A' });
});

test('dailyDraw posts to the daily draw route', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeStoreClient({
    baseUrl: 'http://h',
    publishableKey: 'pk',
    token: 't',
    fetchImpl,
  });
  await c.dailyDraw();
  assert.equal(calls[0].url, 'http://h/store/daily/draw');
  assert.equal(calls[0].opts.method, 'POST');
});

test('requestDelivery sends pull_ids and address_id', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeStoreClient({
    baseUrl: 'http://h',
    publishableKey: 'pk',
    token: 't',
    fetchImpl,
  });
  await c.requestDelivery(['pull_1', 'pull_2'], 'addr_1');
  assert.equal(calls[0].url, 'http://h/store/delivery-orders');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    pull_ids: ['pull_1', 'pull_2'],
    address_id: 'addr_1',
  });
});
