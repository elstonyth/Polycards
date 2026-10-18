import {
  DEFAULT_PLAYER_GROUP_FLAG,
  DEFAULT_PLAYER_GROUP_NAME,
} from './odds-sets';

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
 * A real customer: in no non-default group and not an account the operator
 * generated (metadata.partner_credential, the marker signupTopupStats already
 * excludes on). The group test is EFFECTIVE_GROUP_SQL's (odds-sets.ts) — a
 * membership in a live group neither named DEFAULT nor flagged is_default —
 * asked as "does one exist", so a customer in no group counts as Default.
 * Scope follows CURRENT membership: moving a player into a group moves their
 * whole history with them.
 *
 * Correlated NOT EXISTS, not NOT IN: an anti-join whatever work_mem allows,
 * where NOT IN over a subquery only stays fast while Postgres can hash it.
 */
export const realCustomerSql = (column: string): string => {
  // Inside the subqueries an unqualified name binds to the subquery's own
  // table (cgc.customer_id = cgc.customer_id): always true, excluding
  // everyone. Callers must name the outer table.
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(column)) {
    throw new Error(
      `realCustomerSql: column must be table-qualified, got '${column}'`,
    );
  }
  return (
    'NOT EXISTS (SELECT 1 FROM customer_group_customer cgc ' +
    'JOIN customer_group cg ON cg.id = cgc.customer_group_id AND cg.deleted_at IS NULL ' +
    `WHERE cgc.customer_id = ${column} AND cgc.deleted_at IS NULL ` +
    `AND cg.name IS DISTINCT FROM '${DEFAULT_PLAYER_GROUP_NAME}' ` +
    `AND cg.metadata->'${DEFAULT_PLAYER_GROUP_FLAG}' IS DISTINCT FROM 'true'::jsonb)` +
    ' AND NOT EXISTS (SELECT 1 FROM customer pc ' +
    `WHERE pc.id = ${column} AND pc.metadata -> 'partner_credential' IS NOT NULL)`
  );
};

/** An `AND …` clause for a query's WHERE, or '' for every account. Binds no
 *  parameters, so it can go anywhere in a statement. */
export const scopeSql = (scope: CustomerScope, column: string): string =>
  scope === 'all' ? '' : ` AND ${realCustomerSql(column)}`;

/** Whose money a figure counts: a scope, or one customer (the player page). */
export type MoneyFilter = CustomerScope | { customerId: string };

/** The parameters filterSql's clause binds, in order. */
export const filterParams = (filter: MoneyFilter): unknown[] =>
  typeof filter === 'string' ? [] : [filter.customerId];

/** An `AND …` clause and the parameters it binds. A customer id is always a
 *  bound parameter, never spliced into the SQL; a scope binds none. Splice
 *  `sql` where its `params` fall in the statement's `?` order. */
export const filterSql = (
  filter: MoneyFilter,
  column: string,
): { sql: string; params: unknown[] } =>
  typeof filter === 'string'
    ? { sql: scopeSql(filter, column), params: filterParams(filter) }
    : { sql: ` AND ${column} = ?`, params: filterParams(filter) };
