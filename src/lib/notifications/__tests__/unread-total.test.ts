import { describe, it, expect } from 'vitest';
import { displayUnreadTotal } from '@/lib/notifications/unread-total';

describe('displayUnreadTotal', () => {
  it('shows the full server total when no page rows have been read', () => {
    // 35 unread total, 20 on this page, none marked yet.
    expect(displayUnreadTotal(35, 20, 20)).toBe(35);
  });

  it('decrements the total as page rows are optimistically read', () => {
    // One of the 20 page rows read → 20 - 1 local reads → 34.
    expect(displayUnreadTotal(35, 20, 19)).toBe(34);
  });

  it('reaches exactly zero when the page holds the only unread rows', () => {
    expect(displayUnreadTotal(5, 5, 0)).toBe(0);
  });

  it('is zero after a full clear zeroes serverTotal (Mark-all-read success)', () => {
    // onClearAll sets serverTotal=0 on r.ok; the page still shows its 20 rows.
    expect(displayUnreadTotal(0, 20, 20)).toBe(0);
  });

  it('clamps to zero — never negative — when serverTotal lags the page (stale RSC)', () => {
    // Pathological: server total smaller than the page's own unread.
    expect(displayUnreadTotal(3, 5, 0)).toBe(0);
  });
});
