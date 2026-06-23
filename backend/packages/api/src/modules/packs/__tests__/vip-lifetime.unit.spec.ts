import { lifetimeExternalSen } from '../vip-lifetime';

it('sums external consumed over open debits only; excludes reversals', () => {
  const rows = [
    { amount: -50, reason: 'pack_open', external_funded_cents: -5000 }, // consumed 5000
    { amount: -30, reason: 'pack_open', external_funded_cents: -3000 }, // consumed 3000
    { amount: 50, reason: 'pack_open', external_funded_cents: 5000 }, // REVERSAL (amount>0) — excluded
    { amount: 100, reason: 'topup', external_funded_cents: 10000 }, // not a spend — excluded
    { amount: 7, reason: 'direct_referral', external_funded_cents: 0 }, // commission — excluded
  ];
  expect(lifetimeExternalSen(rows)).toBe(8000); // 5000 + 3000, monotonic
});

it('is empty-safe', () => {
  expect(lifetimeExternalSen([])).toBe(0);
});
