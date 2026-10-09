import type { MedusaRequest } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { EFFECTIVE_GROUP_SQL } from '../../modules/packs/odds-sets';
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

// Defined beside the JS rule it mirrors; re-exported for the reports.
export { EFFECTIVE_GROUP_SQL };

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
