// Pure classifiers over the held-withdrawal approve/deny responses (Task 6,
// plan 094). Kept separate from queries.ts and page.tsx so the branching the
// brief calls out explicitly — the idempotent no-op, the ambiguous submit,
// the never-debited edge case — is unit-testable without the React harness
// this app has no pattern for (no .test.tsx exists anywhere here; see
// withdrawal-outcome.test.ts). The type-only import keeps this file free of
// __BACKEND_URL__ (same trick format.ts uses for DeliveryStatus).
import type {
  GlobePayWithdrawalApproveResult,
  GlobePayWithdrawalDenyResult,
} from './admin-rest';

export type ApproveOutcome = 'submitted' | 'ambiguous' | 'already-handled';

// `approved` alone decides this — NOT `status`, which the route can leave
// stale on the no-op branch (read once, before the claim it then fails to
// make; see approve/route.ts and GlobePayWithdrawalApproveResult's comment).
export function classifyApproveResult(
  data: GlobePayWithdrawalApproveResult,
): ApproveOutcome {
  if (!data.approved) return 'already-handled';
  return data.transaction_id ? 'submitted' : 'ambiguous';
}

export type DenyOutcome = 'refunded' | 'closed-no-refund';

export function classifyDenyResult(
  data: GlobePayWithdrawalDenyResult,
): DenyOutcome {
  return data.refunded ? 'refunded' : 'closed-no-refund';
}
