import { parseScope, realCustomerSql, scopeSql } from '../real-customers';

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
    expect(sql).toContain('gd.customer_id NOT IN');
    expect(sql).toContain('partner_credential');
    expect(realCustomerSql('x.cid')).toContain("IS DISTINCT FROM 'DEFAULT'");
  });
});
