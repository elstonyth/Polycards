import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { buybackPullWorkflow } from '../../../../workflows/buyback-pull';

// POST /store/vault/buyback-batch — sell MANY vaulted pulls in ONE request.
//
// The single-pull /buyback is already atomic and money-safe. The storefront
// used to LOOP it once per selected card, which — under the per-pull rate
// limiter (10/10s burst) — capped a bulk sell at ~10 cards per press and forced
// the customer to hammer the button for a large vault (the reported "sells 10
// then makes me press again, and the rest vanish" bug). This route runs the
// SAME atomic per-pull workflow server-side in a loop, so a 200-card vault
// clears in a single client round-trip and a single rate-limit hit.
//
// Money safety is unchanged and per-pull: each iteration is independently
// atomic (credit row written first under the unique-pull_id guard, then the
// pull is flipped; the step undoes the credit if the flip fails). A pull that
// can't be sold — already sold, out for delivery, not owned, or a frozen
// account — is SKIPPED with its reason and reported back; the others still
// sell. No pull ever leaves 'vaulted' without a matching credit, so a partial
// batch can never lose a card without paying for it.
//
// AUTH + RATE LIMIT: registered in src/api/middlewares.ts (authenticate() then
// the vault-buyback limiter). The customer id comes ONLY from the verified
// token — the body carries pull ids, never a customer id — so a caller can
// only ever sell their own pulls (foreign/again-sold ids 404/NOT_ALLOWED per
// pull, never a cross-customer credit).

// Mirrors VAULT_LIMIT in ../route.ts — a customer can never have more than the
// vault list returns selected at once, so a larger batch is a malformed request.
const MAX_BATCH = 500;

type PullResult = {
  pull_id: string;
  ok: boolean;
  amount?: number;
  error?: string;
};

// A step failure surfaces as a workflow `errors` entry ({ error, action,
// handler }) or, on an infra throw, a wrapper object — neither is a plain
// Error, so pull the human message out of whatever shape arrives (a raw
// String() of it is "[object Object]").
function errorMessage(e: unknown): string {
  if (!e) return 'Could not sell this card.';
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (o.error) return errorMessage(o.error);
  }
  return 'Could not sell this card.';
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;

  // Validate at the trust boundary — a store route is a public endpoint.
  const rawIds = (req.body as { pull_ids?: unknown } | undefined)?.pull_ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "'pull_ids' must be a non-empty array.",
    );
  }
  // Drop non-string/blank entries and dedupe so a repeated id can't be sold
  // twice in one batch (the DB guard would reject the dupe anyway, but this
  // keeps the reported counts honest).
  const ids = [
    ...new Set(
      rawIds
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim()),
    ),
  ];
  if (ids.length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "'pull_ids' contained no valid ids.",
    );
  }
  if (ids.length > MAX_BATCH) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Cannot sell more than ${MAX_BATCH} cards at once.`,
    );
  }

  const workflow = buybackPullWorkflow(req.scope);
  const results: PullResult[] = [];
  let credited = 0;
  for (const id of ids) {
    try {
      // throwOnError:false so a single un-sellable pull (already sold,
      // delivering, not owned, frozen) surfaces as an `errors` entry instead of
      // aborting the loop — record its reason and keep selling the rest.
      const { result, errors } = await workflow.run({
        input: { pull_id: id, customer_id: customerId },
        throwOnError: false,
      });
      if (errors && errors.length > 0) {
        results.push({ pull_id: id, ok: false, error: errorMessage(errors[0]) });
      } else if (result) {
        credited += result.amount;
        results.push({ pull_id: id, ok: true, amount: result.amount });
      } else {
        results.push({ pull_id: id, ok: false, error: 'Could not sell this card.' });
      }
    } catch (error) {
      // Defensive: an infra-level throw (not a step error) still must not abort
      // the batch — the already-committed pulls stay sold + credited.
      results.push({ pull_id: id, ok: false, error: errorMessage(error) });
    }
  }

  const sold = results.filter((r) => r.ok).length;
  // Authoritative post-batch balance (Σ ledger) — read once regardless of how
  // many sold, so the client shows the true new balance even if 0 succeeded.
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const balance = await packs.creditBalance(customerId);

  res.json({
    sold,
    failed: ids.length - sold,
    credited,
    balance,
    results,
  });
}
