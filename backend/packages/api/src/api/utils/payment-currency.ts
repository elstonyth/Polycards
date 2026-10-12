import { MedusaError } from '@medusajs/framework/utils';
import {
  gatewaysFor,
  LEDGER_CURRENCY,
  PAYMENT_CURRENCIES,
  resolveActiveGateway,
  type PaymentGateway,
} from '../../modules/packs/gateway';
import { regionalDepositGateway } from '../../modules/packs/gateway-deposit';

// The admin Settlement page has one tab per currency (RM, then each regional
// rail: SGD). Its reports take ?currency= so each tab shows only its own
// rail's money.

/**
 * The ?currency= (or body.currency) a call is about, upper-cased, or null
 * when none was given. Anything outside `allowed` is a 400, so a typo never
 * quietly reports another rail.
 */
export function paymentCurrencyParam(
  raw: unknown,
  allowed: readonly string[] = PAYMENT_CURRENCIES,
): string | null {
  if (raw === undefined || raw === null) return null;
  const currency = typeof raw === 'string' ? raw.trim().toUpperCase() : null;
  if (currency === '') return null;
  if (currency === null || !allowed.includes(currency)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'currency' must be one of ${allowed.join(', ')}.`,
    );
  }
  return currency;
}

/**
 * The gateway a currency's tab is about: for RM the ACTIVE one (the admin
 * switch picks it), for a regional currency the rail taking its payments
 * (the same pick as a top-up), else its first.
 */
export async function railGateway(
  scope: { resolve: <T>(key: string) => T },
  currency: string,
): Promise<PaymentGateway> {
  return currency === LEDGER_CURRENCY
    ? resolveActiveGateway(scope)
    : (regionalDepositGateway(currency) ?? gatewaysFor(currency)[0]);
}
