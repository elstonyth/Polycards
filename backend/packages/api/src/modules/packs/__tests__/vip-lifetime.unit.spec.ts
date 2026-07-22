import { lifetimeExternalSen } from '../vip-lifetime';

it('sums full open spend over debits only (turnover — funding source irrelevant); excludes reversals', () => {
  const rows = [
    { amount: -50, reason: 'pack_open' }, // deposit-funded or not — counts 5000
    { amount: -30, reason: 'pack_open' }, // winnings-funded open — still counts 3000
    { amount: 50, reason: 'pack_open' }, // REVERSAL (amount>0) — excluded
    { amount: 100, reason: 'topup' }, // not a spend — excluded
    { amount: 7, reason: 'direct_referral' }, // commission — excluded
  ];
  expect(lifetimeExternalSen(rows)).toBe(8000); // 5000 + 3000, monotonic
});

it('is empty-safe', () => {
  expect(lifetimeExternalSen([])).toBe(0);
});
