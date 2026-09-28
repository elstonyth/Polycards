import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import {
  resolvePacks,
  type GatewayDeposits,
} from '../../../../../modules/packs/facets';
import { toMoney } from '../../../../../modules/packs/money';

// The storefront's Meta Pixel reports each settled top-up as a Purchase (plus
// FirstDeposit for the customer's first) — src/lib/pixel.ts. A deposit settles
// on the gateway sweep, not in the customer's browser, so the storefront asks
// here which of the caller's settled deposits are still unreported, reports
// them, and acks them back. "Reported" lives on the row (pixel_reported_at),
// never in a browser, so a customer's devices don't each report a deposit. It
// is at-least-once, not exactly-once: two devices loading in the same second
// can both send before either ack lands (same eventID either way).
//
// AUTH + RATE LIMIT: both methods registered in src/api/middlewares.ts. The
// customer id comes ONLY from the verified token.

/**
 * How far back an unreported settled deposit is still offered. Meta's default
 * click-attribution window: a report later than that could not be credited to
 * an ad anyway.
 */
const REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per read, oldest first. Whatever a browser gets it reports and acks, so the
 * next read offers the rest.
 */
const REPORT_LIMIT = 10;

function callerOf(req: AuthenticatedMedusaRequest): string {
  const customerId = req.auth_context?.actor_id;
  // Fail closed: an empty id would drop out of the filter and match everyone.
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  return customerId;
}

// GET /store/credits/deposit/unreported
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = callerOf(req);
  const packs = resolvePacks<GatewayDeposits>(req.scope);

  const unreported = await packs.listGatewayDeposits(
    {
      customer_id: customerId,
      status: 'settled',
      pixel_reported_at: null,
      settled_at: { $gte: new Date(Date.now() - REPORT_WINDOW_MS) },
    },
    { take: REPORT_LIMIT, order: { settled_at: 'ASC', id: 'ASC' } },
  );

  // "First" is only worth working out when something is being reported, and
  // only while none of the customer's deposits has been: once one has, their
  // first is spoken for. Recomputing it later could hand it to a deposit that
  // committed after but carries an EARLIER settled_at (the sweep stamps its
  // start instant on every deposit it settles) — a second FirstDeposit. The
  // backfill marked every pre-tracking deposit reported, so existing
  // depositors are never "first" again. Within that, by settlement time
  // (never creation: a deposit can expire and settle late), `id` breaking ties.
  let firstId: string | undefined;
  if (unreported.length > 0) {
    const [alreadyReported] = await packs.listGatewayDeposits(
      {
        customer_id: customerId,
        status: 'settled',
        pixel_reported_at: { $ne: null },
      },
      { take: 1, select: ['id'] },
    );
    if (!alreadyReported) {
      const [first] = await packs.listGatewayDeposits(
        { customer_id: customerId, status: 'settled' },
        { take: 1, order: { settled_at: 'ASC', id: 'ASC' }, select: ['id'] },
      );
      firstId = first?.id;
    }
  }

  res.json({
    deposits: unreported.map((deposit) => ({
      merchant_transaction_id: deposit.merchant_transaction_id,
      // The credited figure; the requested one only if none is on file.
      amount: toMoney(deposit.amount_settled ?? deposit.amount_requested),
      first: deposit.id === firstId,
    })),
  });
}

// POST /store/credits/deposit/unreported — { references: string[] }, the
// merchant references the storefront just reported. Idempotent: a reference
// that is not the caller's, not settled, or already acked matches nothing.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = callerOf(req);
  const references = (req.body as { references?: unknown } | undefined)
    ?.references;
  if (
    !Array.isArray(references) ||
    references.length === 0 ||
    references.length > REPORT_LIMIT ||
    !references.every(
      (ref) => typeof ref === 'string' && ref.length > 0 && ref.length <= 64,
    )
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `references must be 1-${REPORT_LIMIT} deposit references.`,
    );
  }

  const packs = resolvePacks<GatewayDeposits>(req.scope);
  const rows = await packs.listGatewayDeposits(
    {
      customer_id: customerId,
      status: 'settled',
      pixel_reported_at: null,
      merchant_transaction_id: references as string[],
    },
    { take: REPORT_LIMIT, select: ['id'] },
  );
  if (rows.length > 0) {
    const now = new Date();
    await packs.updateGatewayDeposits(
      rows.map((row) => ({ id: row.id, pixel_reported_at: now })),
    );
  }

  res.json({ acknowledged: rows.length });
}
