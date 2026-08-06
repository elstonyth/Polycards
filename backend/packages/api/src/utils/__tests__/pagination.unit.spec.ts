import { parseSortParam } from '../pagination';

// The allowlist is a security boundary: every caller feeds the returned key
// into a query builder's order option, and the ledger route feeds it (via its
// own literal map) into a raw ORDER BY. Nothing outside `sortable` may ever
// come back out.
describe('parseSortParam', () => {
  const SORTABLE = new Set(['created_at', 'amount']);

  it('parses an allowlisted key:dir pair', () => {
    expect(parseSortParam('amount:asc', SORTABLE, 'created_at')).toEqual({
      key: 'amount',
      dir: 'ASC',
    });
    expect(parseSortParam('amount:desc', SORTABLE, 'created_at')).toEqual({
      key: 'amount',
      dir: 'DESC',
    });
  });

  it('degrades an unknown key to the fallback, silently', () => {
    expect(parseSortParam('secret_column:asc', SORTABLE, 'created_at')).toEqual(
      { key: 'created_at', dir: 'ASC' },
    );
  });

  it('never passes injection-shaped input through', () => {
    expect(
      parseSortParam('amount; DROP TABLE x--:desc', SORTABLE, 'created_at'),
    ).toEqual({ key: 'created_at', dir: 'DESC' });
  });

  it('treats non-strings (absent, arrays) as the fallback, newest first', () => {
    expect(parseSortParam(undefined, SORTABLE, 'created_at')).toEqual({
      key: 'created_at',
      dir: 'DESC',
    });
    expect(parseSortParam(['amount:asc'], SORTABLE, 'created_at')).toEqual({
      key: 'created_at',
      dir: 'DESC',
    });
  });

  it('anything but literal "asc" is DESC — no third direction', () => {
    expect(parseSortParam('amount:ASC', SORTABLE, 'created_at').dir).toBe(
      'DESC',
    );
    expect(parseSortParam('amount', SORTABLE, 'created_at').dir).toBe('DESC');
  });
});
