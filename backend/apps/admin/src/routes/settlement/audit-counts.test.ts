import { describe, expect, it } from 'vitest';
import { auditCounts } from './audit-counts';

const rows = (n: number) => Array.from({ length: n }, () => ({}));

describe('auditCounts', () => {
  it('a retired gateway row is listed but does not count as a disagreement', () => {
    expect(
      auditCounts({ findings_total: 1, retired_total: 3, findings: rows(4) }),
    ).toEqual({ show: true, differ: 1, retired: 3, all: 4, capped: false });
  });

  it('the 100-row list is capped against every finding, retired included', () => {
    expect(
      auditCounts({
        findings_total: 250,
        retired_total: 3,
        findings: rows(100),
      }).capped,
    ).toBe(true);
  });

  it('only retired rows: listed, nothing differs; none at all: hidden', () => {
    expect(
      auditCounts({ findings_total: 0, retired_total: 2, findings: rows(2) }),
    ).toMatchObject({ show: true, differ: 0, retired: 2 });
    expect(auditCounts({ findings_total: 0, findings: [] }).show).toBe(false);
  });
});
