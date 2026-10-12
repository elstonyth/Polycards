import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  resolvePacks,
  type GatewayWithdrawals,
} from '../../../../modules/packs/facets';
import { openCallback } from '../../../../modules/packs/a3pay';
import { a3payConfigFromEnv } from '../../../../modules/packs/a3pay-client';

// POST /hooks/a3pay/payout-verify — A3Pay Payout Verification. Before paying
// out they POST the payout here; a literal "success" lets it proceed and
// ANYTHING else rejects it on the spot.
//
// A free second factor on the money-out path: even a request that somehow
// reached SubmitPayout with our signature only pays if it matches a pending
// row WE recorded — same reference, same SGD amount we locked, same currency.
// Rejecting a legitimate payout is recoverable (their fail callback refunds
// it); approving an illegitimate one is not.
//
// Unlike the callbacks, the verification Data carries no MerchantCode (the
// handbook lists MerchantTransactionId, Amount, CurrencyCode only), and the
// envelope's MerchantCode is unsigned — so the merchant is not checked here;
// the row match is the gate. A payload that DOES carry one must match.

type Envelope = { Data?: unknown; Signature?: unknown };

type VerifyData = {
  MerchantCode?: string;
  MerchantTransactionId?: string;
  Amount?: number | string;
  CurrencyCode?: string;
};

type Logger = { warn: (m: string) => void; error: (m: string) => void };

/**
 * Breadcrumb on the row: that a verification arrived and how we answered.
 * NULL after a failed payout means their call never reached us — a URL or
 * reachability fault no reading of our own logic would reveal. Raw SQL so it
 * does not move updated_at, which the payout sweep reads as the submit clock.
 * Best effort: a throw here must never turn an answer into a 500.
 */
async function recordVerifyOutcome(
  scope: MedusaRequest['scope'],
  rowId: string | null,
  outcome: string,
): Promise<void> {
  if (!rowId) return;
  try {
    const pg = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as {
      raw: (sql: string, bindings: unknown[]) => Promise<unknown>;
    };
    await pg.raw(
      'UPDATE gateway_withdrawal SET verify_outcome = ? WHERE id = ? AND deleted_at IS NULL',
      [`${new Date().toISOString()} ${outcome.slice(0, 400)}`, rowId],
    );
  } catch (error) {
    try {
      scope
        .resolve<Logger>('logger')
        .warn(
          `[a3pay] could not record verify outcome: ${(error as Error).message}`,
        );
    } catch {
      // nothing left to report with
    }
  }
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const logger = req.scope.resolve<Logger>('logger');
  let config: ReturnType<typeof a3payConfigFromEnv>;
  try {
    config = a3payConfigFromEnv();
  } catch (error) {
    // Not configured on this deploy. 503, so A3Pay retries once it is,
    // rather than an unhandled 500 with a stack in the logs.
    logger.error(
      `[a3pay] payout verification arrived but A3Pay is not configured: ${(error as Error).message}`,
    );
    res.status(503).send('unavailable');
    return;
  }
  const body = (req.body ?? {}) as Envelope;

  let data: VerifyData;
  try {
    if (typeof body.Data !== 'string' || typeof body.Signature !== 'string') {
      throw new Error('missing Data or Signature');
    }
    data = openCallback<VerifyData>(
      { Data: body.Data, Signature: body.Signature },
      config,
    );
  } catch (error) {
    logger.warn(
      `[a3pay] rejected payout verification: ${(error as Error).message}`,
    );
    res.status(400).send('rejected');
    return;
  }

  const merchantTransactionId = String(data.MerchantTransactionId ?? '');
  const packs = resolvePacks<GatewayWithdrawals>(req.scope);
  const [withdrawal] = merchantTransactionId
    ? await packs.listGatewayWithdrawals(
        { merchant_transaction_id: merchantTransactionId, gateway: 'a3pay' },
        { take: 1 },
      )
    : [];

  // One refusal, one reason — the recorded reason is the point of the column.
  const refusal =
    data.MerchantCode !== undefined &&
    String(data.MerchantCode).toUpperCase() !==
      config.merchantCode.toUpperCase()
      ? `names merchant ${data.MerchantCode}, expected ${config.merchantCode}`
      : !withdrawal
        ? 'no such withdrawal row'
        : withdrawal.status !== 'pending'
          ? `row status is ${withdrawal.status}`
          : withdrawal.gateway_amount == null
            ? 'row carries no locked SGD amount'
            : Math.round(Number(data.Amount) * 100) !==
                Math.round(Number(withdrawal.gateway_amount) * 100)
              ? `amount ${data.Amount} != locked ${withdrawal.gateway_amount}`
              : String(data.CurrencyCode ?? '').toUpperCase() !==
                  config.currencyCode.toUpperCase()
                ? `currency ${data.CurrencyCode} != ${config.currencyCode}`
                : null;

  if (refusal) {
    logger.error(
      `[a3pay] payout verification REFUSED for ${merchantTransactionId || 'unknown'}: ${refusal}`,
    );
    await recordVerifyOutcome(
      req.scope,
      withdrawal?.id ?? null,
      `rejected: ${refusal}`,
    );
    res.status(400).send('rejected');
    return;
  }

  await recordVerifyOutcome(req.scope, withdrawal!.id, 'success');
  res.status(200).send('success');
}
