import { describe, expect, it } from 'vitest';
import { auditCounts, gatewayCheck } from './audit-counts';

const rows = (n: number) => Array.from({ length: n }, () => ({}));

describe('auditCounts', () => {
  it('a retired gateway row is listed but does not count as a disagreement', () => {
    expect(
      auditCounts({ findings_total: 1, retired_total: 3, findings: rows(4) }),
    ).toEqual({
      show: true,
      differ: 1,
      retired: 3,
      acknowledged: 0,
      all: 4,
      capped: false,
    });
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

  // Acknowledged on Settlement: listed (greyed), never a disagreement.
  it('an acknowledged finding is listed but does not count as one that differs', () => {
    expect(
      auditCounts({
        findings_total: 1,
        acknowledged_total: 2,
        findings: rows(3),
      }),
    ).toEqual({
      show: true,
      differ: 1,
      retired: 0,
      acknowledged: 2,
      all: 3,
      capped: false,
    });
  });
});

// The "Gateway check" tile at the top of a Settlement tab.
describe('gatewayCheck', () => {
  const at = '2026-10-15T10:00:00Z';
  it('open findings: they differ', () => {
    expect(
      gatewayCheck({ findings_total: 2, acknowledged_total: 1, last_audited_at: at }),
    ).toEqual({ tone: 'differs', count: 2 });
  });
  // Acknowledged is not agreed: the gateway still disagrees with those rows.
  it('only acknowledged findings: never "all match"', () => {
    expect(
      gatewayCheck({ findings_total: 0, acknowledged_total: 3, last_audited_at: at }),
    ).toEqual({ tone: 'acknowledged', count: 3 });
  });
  it('nothing open or acknowledged: all match once audited, else never ran', () => {
    expect(gatewayCheck({ findings_total: 0, last_audited_at: at })).toEqual({
      tone: 'match',
      count: 0,
    });
    expect(gatewayCheck({ findings_total: 0, last_audited_at: null })).toEqual({
      tone: 'never',
      count: 0,
    });
  });
});
