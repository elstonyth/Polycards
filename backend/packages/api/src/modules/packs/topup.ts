import { createHash } from 'node:crypto';

// Credit top-up rules + the mock payment gateway (Task A1). Both are pure so
// the workflow step stays a thin orchestrator and the rules are unit-testable
// without a container.

// Per-request ceiling. Generous for a collectibles site, small enough that a
// typo (or a scripted loop) can't mint an absurd balance in one call.
export const TOPUP_MAX_USD = 10_000;

// Why a message-or-null helper instead of throwing: the step owns the
// MedusaError type (NOT_ALLOWED vs INVALID_DATA), the rule only knows money.
export function topUpAmountError(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Amount must be a number.';
  }
  if (value <= 0) {
    return 'Amount must be greater than zero.';
  }
  if (value > TOPUP_MAX_USD) {
    return `Amount must be at most $${TOPUP_MAX_USD.toLocaleString('en-US')} per top-up.`;
  }
  // 2dp max, checked against the binary representation: 10.1 * 100 is
  // 1009.9999999999999, so an exact integer-cents comparison would reject
  // valid money — the epsilon forgives float error, not sub-cent precision.
  const cents = value * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) {
    return 'Amount cannot be more precise than a cent.';
  }
  return null;
}

// Security audit 2026-06-23: the mock gateway always approves, so it MINTS free
// spendable credit. FAIL CLOSED — only explicit local/test environments allow
// the mock by default; EVERY other environment (production, staging, unset, or
// any custom NODE_ENV) requires an explicit operator opt-in (ALLOW_MOCK_TOPUP=
// true, or 'unsafe-demo' — the only value the production boot-guard below
// accepts). A misconfigured public deploy with NODE_ENV unset/staging must
// never mint credits. Pure (env injected) so the policy is unit-testable.
export function mockTopupAllowed(
  env: { NODE_ENV?: string; ALLOW_MOCK_TOPUP?: string } = process.env,
): boolean {
  if (env.ALLOW_MOCK_TOPUP === 'true' || env.ALLOW_MOCK_TOPUP === 'unsafe-demo') {
    return true;
  }
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

// Production boot-guard (security audit 2026-06-30, Batch A). mockTopupAllowed
// above honours ALLOW_MOCK_TOPUP=true in ANY env — a legitimate opt-in for a
// staging/demo box that has no real gateway yet. But in PRODUCTION that same flag
// would mint free spendable credit through the always-approving mock, so a single
// copy-pasted prod env var becomes a money leak. This guard is the harder
// backstop: it refuses to START a production server with the dangerous
// combination (called at medusa-config load, alongside the JWT/COOKIE secret
// checks). Uses the framework's definition of production ('production' | 'prod').
// Pure (env injected) so the policy is unit-testable without booting.
//
// Demo escape hatch (2026-07-02): prod currently doubles as the DEMO box, so an
// operator can set ALLOW_MOCK_TOPUP=unsafe-demo to run the mock gateway in
// production ON PURPOSE. 'true' (the value every local .env carries) still
// refuses to boot — the guard protects against copy-paste, not against a
// deliberate, weird-looking value. Remove 'unsafe-demo' from the prod spec when
// the real gateway (Batch B) ships.
export function assertMockTopupSafe(
  env: { NODE_ENV?: string; ALLOW_MOCK_TOPUP?: string } = process.env,
): void {
  const isProduction = env.NODE_ENV === 'production' || env.NODE_ENV === 'prod';
  if (isProduction && env.ALLOW_MOCK_TOPUP === 'true') {
    throw new Error(
      'ALLOW_MOCK_TOPUP=true is not permitted in production: the mock payment ' +
        'gateway always approves and mints free spendable credit. Unset ' +
        'ALLOW_MOCK_TOPUP (and wire a real payment provider) before deploying. ' +
        'For a deliberate demo deployment, set ALLOW_MOCK_TOPUP=unsafe-demo.',
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
