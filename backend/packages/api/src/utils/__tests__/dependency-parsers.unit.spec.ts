import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

// Resolve from the consumers so nested vulnerable copies cannot hide behind a
// patched package elsewhere in the workspace.
const coreFlowsRequire = createRequire(require.resolve('@medusajs/core-flows'));
const { parse, CsvError } = coreFlowsRequire(
  'csv-parse',
) as typeof import('csv-parse');
const medusaRequire = createRequire(require.resolve('@medusajs/medusa'));
const qs = medusaRequire('qs') as typeof import('qs');

async function collectCsv(input: string, groupColumns = false) {
  const rows: Record<string, string | string[]>[] = [];
  const parser = parse({
    columns: true,
    skip_empty_lines: true,
    group_columns_by_name: groupColumns,
  });
  for await (const row of Readable.from([input]).pipe(parser)) rows.push(row);
  return rows;
}

describe('dependency parser security overrides', () => {
  it('preserves streamed product-import CSV fields and skips empty rows', async () => {
    await expect(
      collectCsv(
        'product handle,product title\r\ncard,"Rare, Card"\r\n\r\n' +
          'card-2,"Quote ""Rare"""\r\n',
      ),
    ).resolves.toEqual([
      { 'product handle': 'card', 'product title': 'Rare, Card' },
      { 'product handle': 'card-2', 'product title': 'Quote "Rare"' },
    ]);
  });

  it('rejects malformed rows with the CsvError Medusa handles', async () => {
    await expect(collectCsv('handle,title\ncard,title,extra')).rejects.toThrow(
      CsvError,
    );
  });

  it('keeps duplicate __proto__ headers as own data without replacing the prototype', async () => {
    const [row] = await collectCsv(
      '__proto__,__proto__,title\na,b,safe\n',
      true,
    );
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.hasOwn(row, '__proto__')).toBe(true);
    expect(row.__proto__).toEqual(['a', 'b']);
    expect(row.title).toBe('safe');
  });

  it('enforces qs array limits for comma values under bracket keys', () => {
    expect(() =>
      qs.parse('a[]=1,2,3,4', {
        comma: true,
        arrayLimit: 3,
        throwOnLimitExceeded: true,
      }),
    ).toThrow(RangeError);
  });
});
