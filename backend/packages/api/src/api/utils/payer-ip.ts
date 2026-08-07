// The IP a money route reports to GlobePay365 as the PAYING CUSTOMER's address.
//
// THEIR requirement is the paying customer's IP, not ours. req.ip FIRST:
// Medusa's express-loader sets `trust proxy` 1 unconditionally, so req.ip is
// derived from the proxy chain and a client cannot set it. The raw
// X-Forwarded-For first hop is client-controlled — reading it first let a
// caller choose the IP we report to GlobePay365, so it is only a fallback for
// a deployment where req.ip is somehow empty.
//
// This lives here because the deposit and withdrawal routes landed in the same
// commit with OPPOSITE orderings: deposit read req.ip first, withdrawal read
// the header first, so the money-OUT direction — the one a PSP runs geo,
// velocity and AML checks on — was the unhardened half. One helper, both
// routes, and the pair cannot drift again.
//
// Only `ip`, `headers` and `socket` are needed, so the parameter is a narrow
// structural type rather than the full request type: it keeps the helper
// callable from any route shape and keeps its unit tests to plain objects.
export function payerIpOf(req: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string {
  // A `string[]` (Node produces one for a repeated header) deliberately fails
  // this typeof and falls through to the socket — never stringified.
  const forwarded = req.headers['x-forwarded-for'];
  return (
    req.ip ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    req.socket?.remoteAddress ||
    '0.0.0.0'
  );
}
