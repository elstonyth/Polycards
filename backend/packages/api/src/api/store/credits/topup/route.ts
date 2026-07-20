import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { topUpCreditsWorkflow } from '../../../../workflows/topup-credits';
import { notifyFeedNonfatal } from '../../../../modules/packs/notify-feed';
import {
  shouldNotifyTopup,
  topupFeedKey,
} from '../../../../modules/packs/feed-events';

// POST /store/credits/topup — buy site credit through the payment gateway
// seam (mock today: always approves except amounts ending in .13). Appends a
// positive ledger row; the response carries the new balance.
//
// AUTH + RATE LIMIT: registered in src/api/middlewares.ts (authenticate()
// then the credit-topup limiter). The customer id comes ONLY from the
// verified token; amount validation lives in the workflow step with the rest
// of the money rules (invalid amounts 400, gateway declines 400).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const amount = (req.body as { amount?: unknown } | undefined)?.amount;

  // REQUIRED client idempotency key — 400 without one (enforced in the workflow
  // step, after this route's own length guard). A replayed top-up carrying the
  // same key returns the ORIGINAL result instead of double-crediting (audit
  // 2026-06-23; made mandatory in the data-audit branch, 2026-07-07).
  // Header may be string | string[]; normalize + trim. REJECT keys over 200 chars
  // rather than truncating: silently slicing would map two distinct keys that
  // share a 200-char prefix to the same anchor, wrongly treating an independent
  // top-up as a replay (CodeRabbit).
  const rawKey = req.headers['idempotency-key'];
  const headerKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  const trimmedKey = typeof headerKey === 'string' ? headerKey.trim() : '';
  if (trimmedKey.length > 200) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Idempotency-Key must be at most 200 characters.',
    );
  }
  const idempotency_key = trimmedKey !== '' ? trimmedKey : undefined;

  const { result } = await topUpCreditsWorkflow(req.scope).run({
    input: { customer_id: customerId, amount, idempotency_key },
  });

  // Feed receipt for the credit. A replay credited NOTHING (it returned the
  // pre-existing row), so it must not produce a second row. Keyed on the
  // gateway charge reference — the workflow exposes no ledger-row id.
  //
  // Toast policy for this template is 'never' on the storefront: the top-up
  // sheet already confirms the charge on the tab that made it. This row is the
  // durable receipt, and it is what a real gateway webhook will reuse when the
  // charge stops being synchronous.
  //
  // Non-fatal: the credit is already committed.
  if (shouldNotifyTopup(result)) {
    // Non-fatal — never fail a committed top-up over a notification. The
    // wrapper logs a producer failure (PR #222) instead of swallowing silently.
    await notifyFeedNonfatal(req.scope, 'topup', {
      receiverId: customerId,
      template: 'topup_credited',
      data: { amount_myr: result.amount, reference: result.reference },
      idempotencyKey: topupFeedKey(result.reference),
    });
  }

  res.json(result);
}
