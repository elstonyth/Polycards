import { coerceBulkStatusBody, coerceIdSearch } from '../validate';

describe('coerceBulkStatusBody', () => {
  it('accepts a valid body', () => {
    expect(coerceBulkStatusBody({ ids: ['a', 'b'], status: 'processed' })).toEqual({
      ids: ['a', 'b'],
      status: 'processed',
    });
  });
  it.each([
    [{ ids: [], status: 'processed' }],
    [{ ids: ['a', 'a'], status: 'processed' }],           // duplicates
    [{ ids: Array.from({ length: 101 }, (_, i) => `id${i}`), status: 'processed' }], // >100
    [{ ids: ['a'], status: 'packing' }],                  // dead status
    [{ ids: ['a'] }],                                     // missing status
    [{ status: 'processed' }],                            // missing ids
    [{ ids: [1], status: 'processed' }],                  // non-string id
  ])('rejects %j', (body) => {
    expect(() => coerceBulkStatusBody(body)).toThrow();
  });
});

describe('coerceIdSearch', () => {
  it('passes an ordinary id fragment through untouched', () => {
    expect(coerceIdSearch('9T393B')).toBe('9T393B');
  });
  it.each([
    ['', undefined],
    [undefined, undefined],
  ])('treats %j as no filter', (raw, expected) => {
    expect(coerceIdSearch(raw)).toBe(expected);
  });
  // The value is spliced into a LIKE pattern: unescaped `%`/`_` would silently
  // widen the search and a trailing `\` is an invalid escape Postgres errors on.
  it.each([
    ['%', '\\%'],
    ['a_b', 'a\\_b'],
    ['\\', '\\\\'],
  ])('escapes the LIKE metacharacter in %j', (raw, expected) => {
    expect(coerceIdSearch(raw)).toBe(expected);
  });
  it.each([['x'.repeat(65)], [123], [{}]])('rejects %j', (raw) => {
    expect(() => coerceIdSearch(raw)).toThrow();
  });
});
