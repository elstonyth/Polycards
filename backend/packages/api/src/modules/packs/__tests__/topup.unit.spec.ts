import {
  TOPUP_MAX_USD,
  assertMockTopupSafe,
  mockCharge,
  mockTopupAllowed,
  topUpAmountError,
  topupIdempotencyReference,
} from '../topup';

// Task A1 (2026-06-12): credit top-ups through a fake gateway. The amount
// rules and the decline seam are pure functions so the workflow step stays a
// thin orchestrator and the rules are testable without a container.

describe('topUpAmountError', () => {
  it('accepts whole-dollar and 2dp amounts within the cap', () => {
    expect(topUpAmountError(5)).toBeNull();
    expect(topUpAmountError(10.5)).toBeNull();
    expect(topUpAmountError(0.01)).toBeNull();
    expect(topUpAmountError(TOPUP_MAX_USD)).toBeNull();
  });

  it('accepts 2dp amounts that are not exactly representable in binary', () => {
    // 10.1 * 100 = 1009.9999999999999 — a naive integer-cents check would
    // wrongly reject a perfectly valid amount.
    expect(topUpAmountError(10.1)).toBeNull();
    expect(topUpAmountError(0.29)).toBeNull();
  });

  it('rejects zero and negative amounts', () => {
    expect(topUpAmountError(0)).toMatch(/greater than/i);
    expect(topUpAmountError(-5)).toMatch(/greater than/i);
  });

  it('rejects non-finite and non-number values', () => {
    expect(topUpAmountError(NaN)).toMatch(/number/i);
    expect(topUpAmountError(Infinity)).toMatch(/number/i);
    expect(topUpAmountError('50')).toMatch(/number/i);
    expect(topUpAmountError(null)).toMatch(/number/i);
    expect(topUpAmountError(undefined)).toMatch(/number/i);
  });

  it('rejects amounts above the cap', () => {
    expect(topUpAmountError(TOPUP_MAX_USD + 0.01)).toMatch(/at most/i);
  });

  it('rejects sub-cent precision', () => {
    expect(topUpAmountError(1.234)).toMatch(/cent/i);
    expect(topUpAmountError(0.001)).toMatch(/cent/i);
  });
});

describe('mockCharge', () => {
  const customer = 'cus_test';

  it('approves a normal amount with a gateway reference', () => {
    const result = mockCharge({ amount: 25, customer_id: customer });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reference).toMatch(/^mock_/);
    }
  });

  it('issues a distinct reference per charge', () => {
    const a = mockCharge({ amount: 25, customer_id: customer });
    const b = mockCharge({ amount: 25, customer_id: customer });
    if (a.ok && b.ok) {
      expect(a.reference).not.toBe(b.reference);
    } else {
      throw new Error('both charges should approve');
    }
  });

  it('declines any amount ending in .13 (the demo decline path)', () => {
    for (const amount of [0.13, 10.13, 999.13]) {
      const result = mockCharge({ amount, customer_id: customer });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.declined_reason).toMatch(/declined/i);
      }
    }
  });

  it('approves near-miss amounts that do not end in .13', () => {
    for (const amount of [13, 1.3, 10.31, 13.31]) {
      expect(mockCharge({ amount, customer_id: customer }).ok).toBe(true);
    }
  });
});

// Security audit 2026-06-23: the mock gateway mints free, spendable credit, so
// it FAILS CLOSED — only explicit local/test envs allow it by default; every
// other env (production, staging, custom, unset) needs an explicit opt-in. Pure
// so the env policy is unit-testable without a running server.
describe('mockTopupAllowed', () => {
  it('allows the mock in explicit local/test envs without the flag', () => {
    expect(mockTopupAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(mockTopupAllowed({ NODE_ENV: 'test' })).toBe(true);
  });

  it('fails closed for production, staging, custom, or unset NODE_ENV without opt-in', () => {
    expect(mockTopupAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(mockTopupAllowed({ NODE_ENV: 'staging' })).toBe(false);
    expect(mockTopupAllowed({ NODE_ENV: 'qa-7' })).toBe(false);
    expect(mockTopupAllowed({})).toBe(false); // NODE_ENV unset
  });

  it('allows the mock anywhere ONLY when explicitly opted in (ALLOW_MOCK_TOPUP=true)', () => {
    expect(
      mockTopupAllowed({ NODE_ENV: 'production', ALLOW_MOCK_TOPUP: 'true' }),
    ).toBe(true);
    expect(
      mockTopupAllowed({ NODE_ENV: 'staging', ALLOW_MOCK_TOPUP: 'true' }),
    ).toBe(true);
    expect(mockTopupAllowed({ ALLOW_MOCK_TOPUP: 'true' })).toBe(true);
  });

  it("treats non-'true' flag values as not opted in", () => {
    expect(
      mockTopupAllowed({ NODE_ENV: 'production', ALLOW_MOCK_TOPUP: 'false' }),
    ).toBe(false);
    expect(
      mockTopupAllowed({ NODE_ENV: 'production', ALLOW_MOCK_TOPUP: '1' }),
    ).toBe(false);
  });

  it("allows the mock via the deliberate demo value ('unsafe-demo')", () => {
    expect(
      mockTopupAllowed({
        NODE_ENV: 'production',
        ALLOW_MOCK_TOPUP: 'unsafe-demo',
      }),
    ).toBe(true);
    expect(mockTopupAllowed({ ALLOW_MOCK_TOPUP: 'unsafe-demo' })).toBe(true);
  });
});

// Production boot-guard (security audit 2026-06-30, Batch A): ALLOW_MOCK_TOPUP=
// true is a legitimate off-prod opt-in (demo without a real gateway), but it must
// NEVER mint free credit in production. assertMockTopupSafe throws at boot for the
// prod+flag combination so a copy-pasted prod env can't silently enable minting.
describe('assertMockTopupSafe', () => {
  it('throws when production (or prod) is combined with ALLOW_MOCK_TOPUP=true', () => {
    expect(() =>
      assertMockTopupSafe({ NODE_ENV: 'production', ALLOW_MOCK_TOPUP: 'true' }),
    ).toThrow(/production/i);
    expect(() =>
      assertMockTopupSafe({ NODE_ENV: 'prod', ALLOW_MOCK_TOPUP: 'true' }),
    ).toThrow(/production/i);
  });

  it('permits production WITHOUT the flag (mockTopupAllowed already fails closed there)', () => {
    expect(() => assertMockTopupSafe({ NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertMockTopupSafe({
        NODE_ENV: 'production',
        ALLOW_MOCK_TOPUP: 'false',
      }),
    ).not.toThrow();
  });

  it("permits the deliberate demo opt-in ('unsafe-demo') in production", () => {
    // Prod-as-demo (2026-07-02): 'true' (every local .env) still refuses boot,
    // but the weird-looking explicit value boots and enables the mock gateway.
    expect(() =>
      assertMockTopupSafe({
        NODE_ENV: 'production',
        ALLOW_MOCK_TOPUP: 'unsafe-demo',
      }),
    ).not.toThrow();
    expect(
      mockTopupAllowed({
        NODE_ENV: 'production',
        ALLOW_MOCK_TOPUP: 'unsafe-demo',
      }),
    ).toBe(true);
  });

  it('permits the opt-in OFF production (staging/custom/dev/test still allow the mock)', () => {
    expect(() =>
      assertMockTopupSafe({ NODE_ENV: 'staging', ALLOW_MOCK_TOPUP: 'true' }),
    ).not.toThrow();
    expect(() =>
      assertMockTopupSafe({
        NODE_ENV: 'development',
        ALLOW_MOCK_TOPUP: 'true',
      }),
    ).not.toThrow();
    expect(() =>
      assertMockTopupSafe({ ALLOW_MOCK_TOPUP: 'true' }),
    ).not.toThrow(); // NODE_ENV unset
  });
});

// Idempotency anchor for top-ups: a replayed request carrying the same
// Idempotency-Key must resolve to the SAME ledger reference so the locked
// dedupe in mutateCreditAtomic returns the existing row instead of crediting
// again. Customer-scoped so two customers' identical keys never collide.
describe('topupIdempotencyReference', () => {
  it('is deterministic for the same customer + key', () => {
    expect(topupIdempotencyReference('cus_1', 'abc')).toBe(
      topupIdempotencyReference('cus_1', 'abc'),
    );
  });

  it('is customer-scoped (same key, different customers → different refs)', () => {
    expect(topupIdempotencyReference('cus_1', 'abc')).not.toBe(
      topupIdempotencyReference('cus_2', 'abc'),
    );
  });

  it('changes with the key (same customer, different keys → different refs)', () => {
    expect(topupIdempotencyReference('cus_1', 'abc')).not.toBe(
      topupIdempotencyReference('cus_1', 'xyz'),
    );
  });

  it('does not collide with the mock gateway reference namespace', () => {
    expect(topupIdempotencyReference('cus_1', 'abc')).not.toMatch(/^mock_/);
  });
});
