/**
 * THE conditional row-claim — one `UPDATE … RETURNING` and nothing else.
 *
 * WHY THIS EXISTS. Half a dozen flows in this module need to answer "did *I*
 * move this row, or did someone else get here first?" — an admin approve, a
 * settlement payout, a free-pack open, a reveal, a vault flip. Postgres
 * answers it for free in ONE statement: the predicate is re-evaluated against
 * committed state AFTER the row lock releases, so of two concurrent claims
 * exactly one matches a row and the other matches none. The returned rows are
 * that answer.
 *
 * DO NOT REIMPLEMENT THIS WITH `updateX({ selector, data })`. It type-checks
 * and hands back an array, so `length === 0` reads like the same guard, but
 * the generated module service resolves the selector with a find-then-write
 * and takes no row lock: two concurrent callers both read the old state, both
 * see one row, and both act. The bugs that cost us are all this one shape —
 * a duplicate payout to a real bank account (plan 094), a settlement line
 * paid *and* voided (review 2026-08-25), a hit posted twice to a public
 * Telegram channel (revealPull), a card sold back AND shipped (2026-07-07
 * audit #1). A read-then-write is never equivalent, however it is spelled.
 *
 * The statement stays ONE statement for the same reason. Splitting it into a
 * read and a write reintroduces every race above.
 *
 * Identifiers are validated against a strict pattern and interpolated;
 * VALUES ARE ALWAYS BOUND, never interpolated. `deleted_at IS NULL` and
 * `updated_at = now()` are added for you — a raw statement skips MikroORM's
 * onUpdate hook, so nothing else stamps that column.
 */

/** The transactional MikroORM manager surface a claim needs — and the same one
 *  service.ts uses for the advisory lock and the Σ-ledger read, which is why
 *  the name is broader than this file. `?` placeholders are inlined by
 *  MikroORM's formatQuery. */
export type LedgerSqlManager = {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
};

/** `set` sentinel: write the DATABASE's clock, not this process's. */
export const NOW: unique symbol = Symbol('now()');

/** `where` sentinel: `col IS NOT NULL`. (`null` itself means `IS NULL`.) */
export const NOT_NULL: unique symbol = Symbol('IS NOT NULL');

export type Claim = {
  /** Table to claim in. */
  table: string;
  /** Rows the caller wants to move, by `idColumn`. Empty ⇒ nothing to claim. */
  ids: readonly string[];
  /** Key the `ids` address, and the column reported back. Default `id`. */
  idColumn?: string;
  /** Extra predicate. `null` ⇒ `IS NULL`, `NOT_NULL` ⇒ `IS NOT NULL`, an
   *  array ⇒ `IN (…)` (empty ⇒ matches nothing), anything else ⇒ `= ?`. */
  where?: Record<string, unknown>;
  /** Columns to write. `NOW` ⇒ `now()`. `updated_at = now()` is appended
   *  unless the caller sets that column itself. */
  set: Record<string, unknown>;
};

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Identifiers are the only part of a claim that reaches SQL as text, so this
 *  is the boundary that keeps a future caller from routing user input into
 *  one. Values never take this path. */
function identifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`claimRows: unsafe SQL identifier '${name}'`);
  }
  return name;
}

/**
 * Runs ONE `UPDATE … RETURNING <idColumn>`, and returns the ids THIS statement
 * moved (a subset of `ids`). Never throws on zero rows — a lost claim is an
 * answer, not an error, and what to do about it is the caller's decision.
 */
export async function claimRows(
  em: LedgerSqlManager,
  claim: Claim,
): Promise<string[]> {
  // Every identifier is validated BEFORE any short-circuit below, so an
  // unsafe one is a throw whether or not the claim would have queried.
  const table = identifier(claim.table);
  const idColumn = identifier(claim.idColumn ?? 'id');
  const setEntries = Object.entries(claim.set).map(
    ([column, value]) => [identifier(column), value] as const,
  );
  const whereEntries = Object.entries(claim.where ?? {}).map(
    ([column, value]) => [identifier(column), value] as const,
  );

  const params: unknown[] = [];

  const setSql = setEntries.map(([column, value]) => {
    if (value === NOW) return `${column} = now()`;
    params.push(value);
    return `${column} = ?`;
  });
  // An explicit updated_at wins: Postgres rejects two assignments to one
  // column.
  if (!setEntries.some(([column]) => column === 'updated_at')) {
    setSql.push('updated_at = now()');
  }

  if (claim.ids.length === 0) return [];
  const whereSql = [
    claim.ids.length === 1
      ? `${idColumn} = ?`
      : `${idColumn} IN (${claim.ids.map(() => '?').join(', ')})`,
  ];
  params.push(...claim.ids);

  for (const [column, value] of whereEntries) {
    if (value === null) {
      whereSql.push(`${column} IS NULL`);
      continue;
    }
    if (value === NOT_NULL) {
      whereSql.push(`${column} IS NOT NULL`);
      continue;
    }
    if (Array.isArray(value)) {
      // `IN ()` is a syntax error, and an empty list matches nothing anyway.
      if (value.length === 0) return [];
      whereSql.push(`${column} IN (${value.map(() => '?').join(', ')})`);
      params.push(...value);
      continue;
    }
    whereSql.push(`${column} = ?`);
    params.push(value);
  }
  whereSql.push('deleted_at IS NULL');

  const rows = await em.execute<Record<string, unknown>[]>(
    `UPDATE ${table} SET ${setSql.join(', ')} ` +
      `WHERE ${whereSql.join(' AND ')} ` +
      `RETURNING ${idColumn}`,
    params,
  );
  return rows.map((row) => String(row[idColumn]));
}

/** `claimRows` for a single row: true iff THIS caller moved it. */
export async function claimOne(
  em: LedgerSqlManager,
  claim: Claim & { ids: readonly [string] },
): Promise<boolean> {
  return (await claimRows(em, claim)).length > 0;
}
