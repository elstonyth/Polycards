import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { topUpCreditsWorkflow } from '../../../../workflows/topup-credits';

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

  // Optional client idempotency key — a replayed top-up carrying the same key
  // returns the original result instead of double-crediting (audit 2026-06-23).
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

  res.json(result);
}
