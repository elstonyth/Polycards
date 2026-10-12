import { MedusaError } from '@medusajs/framework/utils';
import {
  gatewaysFor,
  LEDGER_CURRENCY,
  PAYMENT_CURRENCIES,
  resolveActiveGateway,
  type PaymentGateway,
} from '../../modules/packs/gateway';

// The admin Settlement page has one tab per currency (RM, then each regional
// rail: SGD). Its reports take ?currency= so each tab shows only its own
// rail's money.

/**
 * The currency a report is scoped to, upper-cased, or null when none was
 * asked for. Anything outside PAYMENT_CURRENCIES is a 400, so a typo never
 * quietly reports another rail.
 */
export function paymentCurrencyParam(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const currency = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!PAYMENT_CURRENCIES.includes(currency)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'currency' must be one of ${PAYMENT_CURRENCIES.join(', ')}.`,
    );
  }
  return currency;
}

/**
 * The gateway a currency's tab is about: for RM the ACTIVE one (the admin
 * switch picks it), for a regional currency its own rail.
 */
export async function railGateway(
  scope: { resolve: <T>(key: string) => T },
  currency: string,
): Promise<PaymentGateway> {
  return currency === LEDGER_CURRENCY
    ? resolveActiveGateway(scope)
    : gatewaysFor(currency)[0];
}
