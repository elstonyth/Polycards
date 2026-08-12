import { describe, it, expect } from 'vitest';
import { classifyApproveResult, classifyDenyResult } from './withdrawal-outcome';

// Pins the three real shapes ./[id]/approve can return (see its route.ts) to
// a small closed outcome type, so page.tsx never has to re-derive "what does
// this response mean" from raw fields — and so that derivation is testable
// without the React harness this repo has no pattern for (see withdrawals
// page.tsx: there is no .test.tsx anywhere in this app).
describe('classifyApproveResult', () => {
  it('is "submitted" once the gateway returned a transaction id', () => {
    expect(
      classifyApproveResult({
        id: 'gpw_1',
        status: 'pending',
        transaction_id: 'W2026081200000001',
        approved: true,
      }),
    ).toBe('submitted');
  });

  it('is "ambiguous" when approved but the gateway outcome is unknown — no transaction id, left pending for the sweep', () => {
    expect(
      classifyApproveResult({
        id: 'gpw_1',
        status: 'pending',
        transaction_id: null,
        approved: true,
      }),
    ).toBe('ambiguous');
  });

  // approved:false is the route's idempotent no-op — a double-click, or
  // another admin's tab, already moved the row out of 'held'. `status` here
  // can be STALE (the route reads it once, before the claim it attempted
  // fails — see approve/route.ts), so the classifier must not lean on it,
  // only on `approved`.
  it('is "already-handled" on the idempotent no-op, regardless of what status claims', () => {
    expect(
      classifyApproveResult({
        id: 'gpw_1',
        status: 'held',
        transaction_id: null,
        approved: false,
      }),
    ).toBe('already-handled');
    expect(
      classifyApproveResult({
        id: 'gpw_1',
        status: 'pending',
        transaction_id: 'W2026081200000001',
        approved: false,
      }),
    ).toBe('already-handled');
  });
});

describe('classifyDenyResult', () => {
  it('is "refunded" when the debit came back', () => {
    expect(
      classifyDenyResult({ id: 'gpw_1', status: 'failed', refunded: true }),
    ).toBe('refunded');
  });

  // The bound-finding edge case from Task 5: a held row is not always
  // debited (a crash between the row insert and the debit strands one), so
  // deny closes it WITHOUT refunding — a distinct outcome the operator
  // should not read as "nothing happened".
  it('is "closed-no-refund" for the never-debited edge case', () => {
    expect(
      classifyDenyResult({ id: 'gpw_1', status: 'failed', refunded: false }),
    ).toBe('closed-no-refund');
  });
});
