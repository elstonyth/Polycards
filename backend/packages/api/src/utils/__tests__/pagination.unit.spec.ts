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

  // A miss restores the caller's WHOLE default, direction included. Honouring
  // `:asc` from a request whose key we refused would flip a route's default
  // order on the strength of the one half we couldn't honour anyway.
  it('degrades an unknown key to the fallback key AND direction, silently', () => {
    expect(parseSortParam('secret_column:asc', SORTABLE, 'created_at')).toEqual(
      { key: 'created_at', dir: 'DESC' },
    );
    // The globepay lists pass their status-dependent default direction in, so
    // a bad key cannot knock the pending work queue out of oldest-first.
    expect(
      parseSortParam('secret_column:desc', SORTABLE, 'created_at', 'ASC'),
    ).toEqual({ key: 'created_at', dir: 'ASC' });
  });

  it('honours the requested direction only when the key is allowlisted', () => {
    expect(
      parseSortParam('amount:asc', SORTABLE, 'created_at', 'DESC'),
    ).toEqual({ key: 'amount', dir: 'ASC' });
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
    // An absent param is the same case as a refused one — both mean "the
    // caller expressed nothing we can act on", so both get the full default.
    expect(parseSortParam(undefined, SORTABLE, 'created_at', 'ASC')).toEqual({
      key: 'created_at',
      dir: 'ASC',
    });
  });

  it('anything but literal "asc" is DESC — no third direction', () => {
    expect(parseSortParam('amount:ASC', SORTABLE, 'created_at').dir).toBe(
      'DESC',
    );
    expect(parseSortParam('amount', SORTABLE, 'created_at').dir).toBe('DESC');
  });
});
