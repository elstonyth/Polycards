import { describe, expect, it } from 'vitest';
import { mdBlocks } from '../markdown-parse';

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
