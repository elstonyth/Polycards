import { createHash } from 'node:crypto';

// Credit top-up rules + the mock payment gateway (Task A1). Both are pure so
// the workflow step stays a thin orchestrator and the rules are unit-testable
// without a container.

// Per-request ceiling. Generous for a collectibles site, small enough that a
// typo (or a scripted loop) can't mint an absurd balance in one call.
export const TOPUP_MAX_RM = 10_000;

// Why a message-or-null helper instead of throwing: the step owns the
// MedusaError type (NOT_ALLOWED vs INVALID_DATA), the rule only knows money.
export function topUpAmountError(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Amount must be a number.';
  }
  if (value <= 0) {
    return 'Amount must be greater than zero.';
  }
  if (value > TOPUP_MAX_RM) {
    return `Amount must be at most RM ${TOPUP_MAX_RM.toLocaleString('en-US')} per top-up.`;
  }
  // 2dp max, checked against the binary representation: 0.07 * 100 is
  // 7.000000000000001, so an exact integer-cents comparison would reject
  // valid money — the epsilon forgives float error, not sub-cent precision.
  // (NOT 10.1, which this comment used to cite: 10.1 * 100 is exactly 1010.)
  const cents = value * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) {
    return 'Amount cannot be more precise than a cent.';
  }
  return null;
}

// Security audit 2026-06-23: the mock gateway always approves, so it MINTS free
// spendable credit. FAIL CLOSED — only explicit local/test environments allow
// the mock by default; EVERY other environment (production, staging, unset, or
// any custom NODE_ENV) requires an explicit operator opt-in
// (ALLOW_MOCK_TOPUP=true). A misconfigured public deploy with NODE_ENV
// unset/staging must never mint credits. Pure (env injected) so the policy is
// unit-testable.
//
// The 'unsafe-demo' value is GONE (2026-07-29). It existed only to run the
// always-approving mock in production while there was no real gateway; the
// GlobePay365 gateway is that gateway, so production has no legitimate reason
// to mint credit again — see assertMockTopupSafe below.
export function mockTopupAllowed(
  env: { NODE_ENV?: string; ALLOW_MOCK_TOPUP?: string } = process.env,
): boolean {
  if (env.ALLOW_MOCK_TOPUP === 'true') {
    return true;
  }
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

// Production boot-guard (security audit 2026-06-30, Batch A; hardened
// 2026-07-29). mockTopupAllowed above honours ALLOW_MOCK_TOPUP=true in ANY env
// — a legitimate opt-in for a staging box with no real gateway. In PRODUCTION
// that same flag mints free spendable credit through the always-approving mock,
// so this guard refuses to START a production server with the variable set to
// ANYTHING (called at medusa-config load, alongside the JWT/COOKIE secret
// checks). Uses the framework's definition of production ('production' |
// 'prod'). Pure (env injected) so the policy is unit-testable without booting.
//
// It rejects any value, not just 'true', because the old 'unsafe-demo' escape
// hatch is gone: it existed to run the mock in production while there was no
// real gateway, and GlobePay365 is now that gateway. A value the guard did not
// recognise must fail loudly rather than boot a server whose top-up path is
// silently disabled — an operator who set the variable meant something by it.
//
// DEPLOY ORDER: the production spec still carried ALLOW_MOCK_TOPUP=unsafe-demo
// when this shipped. It has to come OFF in the same spec update that adds the
// GLOBEPAY_* vars, or the first deploy after this change refuses to boot.
export function assertMockTopupSafe(
  env: { NODE_ENV?: string; ALLOW_MOCK_TOPUP?: string } = process.env,
): void {
  const isProduction = env.NODE_ENV === 'production' || env.NODE_ENV === 'prod';
  if (isProduction && env.ALLOW_MOCK_TOPUP !== undefined) {
    throw new Error(
      `ALLOW_MOCK_TOPUP is set (${env.ALLOW_MOCK_TOPUP}) but is not permitted ` +
        'in production: the mock payment gateway always approves and mints ' +
        'free spendable credit. Remove the variable from the production spec ' +
        'and use the real payment gateway (GLOBEPAY_ENABLED=true).',
    );
  }
}

// Customer-scoped idempotency anchor for a top-up. A replayed request carrying
// the same Idempotency-Key resolves to this same anchor, so the per-customer
// locked dedupe in mutateCreditAtomic returns the existing row instead of
// appending a second credit (the audit's no-idempotency finding). The anchor is
// an OPAQUE sha256 digest of (customerId, key) — the raw client header content
// is never persisted verbatim in the ledger. The customer id is folded into the
// digest (JSON-framed, so "a"+"bc" ≠ "ab"+"c") so two customers' identical
// keys never collide, and the `topup-idem:` prefix keeps it disjoint from the
// mock gateway's `mock_…` references.
export function topupIdempotencyReference(
  customerId: string,
  key: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ customerId, key }))
    .digest('hex');
  return `topup-idem:${digest}`;
}

export type TopUpResult = {
  /** MYR (RM) credited (decimal, never cents). */
  amount: number;
  /** The gateway's charge reference (mock today, real later). */
  reference: string;
  /** The customer's new credit balance (Σ ledger). */
  balance: number;
  /**
   * True when this request replayed an already-processed Idempotency-Key:
   * nothing new was charged or credited (sim finding P2-4 — without this flag
   * a replay was indistinguishable from a second successful charge).
   */
  replayed: boolean;
};

// Shapes the public top-up response from the ledger mutation outcome. On a
// replay the mock gateway still minted a FRESH reference (it was charged
// before the dedupe could run), but returning it would look like a second
// successful charge — surface the ORIGINAL row's stored reference instead,
// falling back to the fresh one only if the original row carries none.
export function buildTopUpResult(
  mutation: {
    amount: number;
    balance: number;
    replayed: boolean;
    reference: string | null;
  },
  chargeReference: string,
): TopUpResult {
  return {
    // On a replay this is the ORIGINAL credited amount, not the (ignored)
    // amount on the replayed request body.
    amount: mutation.amount,
    reference:
      mutation.replayed && mutation.reference
        ? mutation.reference
        : chargeReference,
    balance: mutation.balance,
    replayed: mutation.replayed,
  };
}

export type MockChargeInput = {
  amount: number;
  customer_id: string;
};

export type MockChargeResult =
  | { ok: true; reference: string }
  | { ok: false; declined_reason: string };

// Unique-enough for a demo gateway; the DB row id is the real identity.
let chargeSeq = 0;

/**
 * The payment-gateway seam: the real gateway replaces exactly this function
 * (same input, same result shape). Always approves, except amounts ending in
 * .13 — a deliberate fake decline so the UI's error path stays testable
 * end-to-end without a real gateway.
 */
export function mockCharge(input: MockChargeInput): MockChargeResult {
  const cents = Math.round(input.amount * 100);
  if (cents % 100 === 13) {
    return {
      ok: false,
      declined_reason:
        'Payment declined by the demo gateway (amounts ending in .13 always decline).',
    };
  }
  return {
    ok: true,
    reference: `mock_${Date.now().toString(36)}_${(chargeSeq++).toString(36)}`,
  };
}
