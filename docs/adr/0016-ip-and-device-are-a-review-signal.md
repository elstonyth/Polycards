# IP address and browser id are a clue for support, never a block

Owner's policy is one person, one account (ADR 0015). The bank rule stops cash-out,
but a person with another bank and phone can still open accounts. So we record which
network and browser each account was seen on, and show support the overlap on the
player page.

It is a review signal only. Nothing refuses a customer because of it, and it must stay
that way. Malaysian mobile carriers put many strangers on one IP address, so an IP
match alone proves little, and a farmer can switch networks or clear a cookie. A
shared browser id is the stronger clue, and even that can be a shared family device.

- **The address is the one the storefront already signs** (`x-visitor-ip`,
  `api/utils/visitor-ip.ts`), so a direct call to the backend cannot name one. An
  unsigned request records nothing. IPv6 is stored as its /64.
- **The browser id is a random first-party cookie**, sent beside the signed pair and
  read only when the pair verifies. It is created on a write only, because a
  `Set-Cookie` on an anonymous page would stop the CDN caching it. It is a security
  cookie, so the cookie banner does not gate it, and the privacy page says so.
- **Recorded at signup, task claims, check-in and withdrawal**, which are low-traffic.
  Signup means the one-time real-name step, the one write every new account makes.
  Not on pack opens: the welcome pack shares that route with every paid spin, and the
  real-name step already comes before it.
- **Never in the way.** The write is not awaited, and a failure only logs.
- **Kept 180 days**, then purged by a daily job, and removed on account deletion.

Fenced like a bank number (`customer_bank_account:read`), since an IP address is
personal data. There is no backfill: nothing was stored before this.
