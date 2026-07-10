// Admin-side HTTP client. Deliberately narrow: it exposes ONLY operations the
// real admin API supports. When the admin agent needs something with no method
// here, that gap is a `missing-capability` finding — not a reason to reach past
// the API. Routes verified under src/api/admin/.
export function makeAdminClient({ baseUrl, token, fetchImpl = fetch }) {
  const headers = () => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  async function call(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: headers(),
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
    login: (email, password) =>
      call('POST', '/auth/user/emailpass', { email, password }),
    getCustomerTransactions: (id) =>
      call('GET', `/admin/customers/${id}/transactions`),
    adjustCredits: (id, amount, reason) =>
      call('POST', `/admin/customers/${id}/credits`, { amount, reason }),
    freeze: (id, reason) =>
      call('POST', `/admin/customers/${id}/freeze`, { reason }),
    unfreeze: (id) => call('POST', `/admin/customers/${id}/unfreeze`, {}),
    getDeliveryOrder: (id) => call('GET', `/admin/delivery-orders/${id}`),
    updateDeliveryOrder: (id, patch) =>
      call('POST', `/admin/delivery-orders/${id}`, patch),
    reverseCommission: (id, reason) =>
      call('POST', `/admin/commissions/${id}/reverse`, { reason }),
  };
}
