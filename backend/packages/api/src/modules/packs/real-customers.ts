import { EFFECTIVE_GROUP_SQL } from './odds-sets';

/** Who a money figure counts: real customers only, or every account. */
export type CustomerScope = 'default' | 'all';

/** `?scope=` → scope; absent/blank → `fallback`; anything else → null (400). */
export function parseScope(
  raw: unknown,
  fallback: CustomerScope,
): CustomerScope | null {
  if (raw === undefined || raw === '') return fallback;
  return raw === 'default' || raw === 'all' ? raw : null;
}

/**
 * A real customer: in no non-default group (EFFECTIVE_GROUP_SQL is the odds
 * engine's own rule, so a customer in no group counts as Default) and not an
 * account the operator generated (metadata.partner_credential, the marker
 * signupTopupStats already excludes on). Scope follows CURRENT membership:
 * moving a player into a group moves their whole history with them.
 */
export const realCustomerSql = (column: string): string =>
  `${column} NOT IN (SELECT customer_id FROM (${EFFECTIVE_GROUP_SQL}) eff)` +
  ` AND ${column} NOT IN (SELECT id FROM customer WHERE metadata -> 'partner_credential' IS NOT NULL)`;

/** An `AND …` clause for a query's WHERE, or '' for every account. Binds no
 *  parameters, so it can go anywhere in a statement. */
export const scopeSql = (scope: CustomerScope, column: string): string =>
  scope === 'all' ? '' : ` AND ${realCustomerSql(column)}`;
