import type { MedusaRequest } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import type { GroupScope, ReportWindow } from './params';

/** The slice of knex the reports use. Every value goes in as a binding. */
export type ReportDb = {
  raw<T>(sql: string, bindings?: readonly unknown[]): Promise<{ rows: T[] }>;
};

// Reports read through the app's shared Postgres connection rather than the
// packs service: they are read-only aggregates, and keeping them here leaves
// the money-path service untouched.
export const reportDb = (req: MedusaRequest): ReportDb =>
  req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION,
  ) as unknown as ReportDb;

/** A WHERE fragment (starting with " AND", or empty) and its bindings. */
export type SqlPart = { sql: string; params: unknown[] };

// Every customer's EFFECTIVE player group: the SQL twin of
// effectivePlayerGroup + isDefaultPlayerGroup (modules/packs/odds-sets.ts).
// The oldest live membership (group created_at, then id) in a live group that
// is neither named DEFAULT nor flagged is_default. A customer with no row
// here is in DEFAULT. Same joins as PacksModuleService.partnerGroupOfCustomers.
export const EFFECTIVE_GROUP_SQL =
  'SELECT DISTINCT ON (cgc.customer_id) cgc.customer_id, cg.id AS group_id ' +
  'FROM customer_group_customer cgc ' +
  'JOIN customer_group cg ON cg.id = cgc.customer_group_id AND cg.deleted_at IS NULL ' +
  'WHERE cgc.deleted_at IS NULL ' +
  "AND cg.name IS DISTINCT FROM 'DEFAULT' " +
  "AND cg.metadata->'is_default' IS DISTINCT FROM 'true'::jsonb " +
  'ORDER BY cgc.customer_id, cg.created_at ASC, cg.id ASC';

/** Restricts `column` (a non-null customer id column) to the scope's players. */
export function scopeFilter(scope: GroupScope, column: string): SqlPart {
  if (scope.kind === 'all') return { sql: '', params: [] };
  if (scope.kind === 'default') {
    return {
      sql: ` AND ${column} NOT IN (SELECT customer_id FROM (${EFFECTIVE_GROUP_SQL}) eff)`,
      params: [],
    };
  }
  return {
    sql: ` AND ${column} IN (SELECT customer_id FROM (${EFFECTIVE_GROUP_SQL}) eff WHERE eff.group_id = ?)`,
    params: [scope.id],
  };
}

/** Restricts `column` (a timestamptz) to the half-open window. */
export function windowFilter(window: ReportWindow, column: string): SqlPart {
  const part: SqlPart = { sql: '', params: [] };
  if (window.from) {
    part.sql += ` AND ${column} >= ?::timestamptz`;
    part.params.push(window.from);
  }
  if (window.to) {
    part.sql += ` AND ${column} < ?::timestamptz`;
    part.params.push(window.to);
  }
  return part;
}

/** Restricts `column` to one customer. */
export const customerFilter = (
  customerId: string,
  column: string,
): SqlPart => ({
  sql: ` AND ${column} = ?`,
  params: [customerId],
});

/** Joins WHERE fragments into one, bindings in order. */
export const and = (...parts: SqlPart[]): SqlPart => ({
  sql: parts.map((p) => p.sql).join(''),
  params: parts.flatMap((p) => p.params),
});
