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
  `api/utils/visitor-ip.ts`), so a direct call to the backend cannot name one. A
  request without a valid signature is stored as `unsigned`, believing nothing it
  claims, and support sees that the account was used outside the site. IPv6 is stored
  as its /64.
- **The browser id is a random first-party cookie**, sent beside the signed pair and
  read only when the pair verifies. It is created on a signed-in write only: a
  `Set-Cookie` on an anonymous page would stop the CDN caching it, and setting a cookie
  makes a server action render the whole page, which a bot replaying a form must not
  trigger. It is a security cookie, so the cookie banner does not gate it, and the
  privacy page says so. Its value comes from the browser, so one account stops adding
  rows at 200.
- **Recorded at signup, task claims, check-in and withdrawal**, which are low-traffic.
  Signup means the one-time real-name step, the one write every new account makes.
  Not on pack opens: the welcome pack shares that route with every paid spin, and the
  real-name step already comes before it.
- **Never in the way.** The write is not awaited, and a failure only logs a code, since
  the driver's message can carry the values.
- **Kept 180 days** from last seen, then purged by a daily job, and removed on account
  deletion.

Fenced like a bank number (`customer_bank_account:read`), since an IP address is
personal data, and each view that shows a match leaves an audit row. The desk bots do
not get it: they hold `*:read`, so their query tool refuses the table and their proxy
refuses the route. There is no backfill: nothing was stored before this.
