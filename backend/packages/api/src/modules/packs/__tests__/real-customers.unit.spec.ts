import {
  filterSql,
  parseScope,
  realCustomerSql,
  scopeSql,
} from '../real-customers';

describe('real-customer scope', () => {
  it('parses default / all, falls back when absent, rejects anything else', () => {
    expect(parseScope('default', 'all')).toBe('default');
    expect(parseScope('all', 'default')).toBe('all');
    expect(parseScope(undefined, 'all')).toBe('all');
    expect(parseScope('', 'default')).toBe('default');
    expect(parseScope('partners', 'all')).toBeNull();
    expect(parseScope(['all'], 'all')).toBeNull();
  });

  it('adds no SQL for all, and both exclusions for default', () => {
    expect(scopeSql('all', 'gd.customer_id')).toBe('');
    const sql = scopeSql('default', 'gd.customer_id');
    expect(sql.startsWith(' AND ')).toBe(true);
    expect(sql).toContain('partner_credential');
    expect(sql).toContain("IS DISTINCT FROM 'DEFAULT'");
  });

  // NOT EXISTS plans as an anti-join whatever work_mem allows; NOT IN over a
  // subquery only stays fast while Postgres can hash it, and falls back to a
  // rescan per row on a large customer table.
  it('excludes with correlated NOT EXISTS, never NOT IN', () => {
    const sql = realCustomerSql('x.cid');
    expect(sql).not.toContain('NOT IN');
    expect(sql.match(/NOT EXISTS/g)).toHaveLength(2);
    expect(sql).toContain('cgc.customer_id = x.cid');
    expect(sql).toContain('pc.id = x.cid');
  });

  // Inside the subqueries an unqualified 'customer_id' would bind to the
  // subquery's own table (cgc.customer_id = cgc.customer_id): always true,
  // excluding everyone. The column must name its table.
  it('refuses an unqualified column', () => {
    expect(() => realCustomerSql('customer_id')).toThrow(/qualified/);
    expect(() => scopeSql('default', 'id')).toThrow(/qualified/);
    expect(scopeSql('all', 'id')).toBe('');
  });

  // One customer (the player page's money card): a bound parameter, never
  // the id spliced into the SQL; a scope keeps scopeSql's text and binds none.
  it('filters to one customer with a bound parameter', () => {
    expect(
      filterSql({ customerId: "cus_1' OR '1'='1" }, 'gd.customer_id'),
    ).toEqual({
      sql: ' AND gd.customer_id = ?',
      params: ["cus_1' OR '1'='1"],
    });
    expect(filterSql('all', 'gd.customer_id')).toEqual({ sql: '', params: [] });
    expect(filterSql('default', 'gd.customer_id')).toEqual({
      sql: scopeSql('default', 'gd.customer_id'),
      params: [],
    });
  });
});
