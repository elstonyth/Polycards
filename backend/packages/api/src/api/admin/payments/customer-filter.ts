/**
 * `?customer_id=cus_…` narrows the deposits / withdrawals lists to one customer
 * — the admin player page's Payments tab. Absent = every customer (the global
 * pages, unchanged). A value that is present but not a customer id is
 * `invalid`: the route answers 400 rather than silently dropping the filter,
 * which would show a support agent every customer's payments under one name.
 */
export function parseCustomerFilter(
  raw: unknown,
): { customer_id: string } | Record<string, never> | 'invalid' {
  if (raw === undefined) return {};
  return typeof raw === 'string' && /^cus_[0-9A-Z]{26}$/.test(raw)
    ? { customer_id: raw }
    : 'invalid';
}
