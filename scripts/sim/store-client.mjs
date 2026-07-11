// Thin customer-side HTTP client. Every method returns { status, body } so
// agents (and the auditor's repro replay) can assert on exact responses.
export function makeStoreClient({
  baseUrl,
  publishableKey,
  token,
  fetchImpl = fetch,
}) {
  const headers = (extra = {}) => ({
    'Content-Type': 'application/json',
    ...(publishableKey ? { 'x-publishable-api-key': publishableKey } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  async function call(method, path, { body, extraHeaders } = {}) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: headers(extraHeaders),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  return {
    register: (email, password) =>
      call('POST', '/auth/customer/emailpass/register', {
        body: { email, password },
      }),
    // Middle step of the three-step onboarding: links the auth identity from
    // register() to a real customer record. Uses the register token, NOT this
    // client's own (possibly unset) token — without this call the eventual
    // login() token resolves no actor and every authed call 400s/401s.
    createCustomer: (registerToken, { email, first_name }) =>
      call('POST', '/store/customers', {
        body: { email, first_name },
        extraHeaders: { Authorization: `Bearer ${registerToken}` },
      }),
    login: (email, password) =>
      call('POST', '/auth/customer/emailpass', { body: { email, password } }),
    topup: (amount, idempotencyKey) =>
      call('POST', '/store/credits/topup', {
        body: { amount },
        extraHeaders: { 'Idempotency-Key': idempotencyKey },
      }),
    openPack: (slug) => call('POST', `/store/packs/${slug}/open`, { body: {} }),
    getCredits: () => call('GET', '/store/credits'),
    getVault: () => call('GET', '/store/vault'),
    buyback: (vaultId) =>
      call('POST', `/store/vault/${vaultId}/buyback`, { body: {} }),
    createAddress: (address) =>
      call('POST', '/store/customers/me/addresses', { body: address }),
    requestDelivery: (pullIds, addressId) =>
      call('POST', '/store/delivery-orders', {
        body: { pull_ids: pullIds, address_id: addressId },
      }),
    dailyDraw: () => call('POST', '/store/daily/draw', { body: {} }),
  };
}
