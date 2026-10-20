/**
 * The home page's feed read must be memoised per process, not just per ISR
 * window. A form-encoded POST to `/`, or a cookie-setting server action there,
 * skips the route cache and re-renders the whole tree, and getRecentPulls()
 * was the one read in it with no memo of its own — every such render cost one
 * backend call to /store/pulls/recent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getRecentPulls } = vi.hoisted(() => ({
  getRecentPulls: vi.fn(async () => ({ pulls: [], drought: {} })),
}));

vi.mock('@/lib/data/packs', () => ({
  getPackCategories: vi.fn(async () => []),
  getPackHighlights: vi.fn(async () => null),
  getRecentPulls,
}));
vi.mock('@/lib/data/leaderboard', () => ({
  getLeaderboard: vi.fn(async () => []),
}));
// The page only references these; it never renders them in this test.
vi.mock('@/components/home/HeroBoard', () => ({ default: () => null }));
vi.mock('@/components/home/PullsMarquee', () => ({ default: () => null }));
vi.mock('@/components/home/TierShelf', () => ({ default: () => null }));
vi.mock('@/components/RecentPullsSection', () => ({ default: () => null }));
vi.mock('@/components/home/TheGame', () => ({ default: () => null }));
vi.mock('@/components/home/FinalCta', () => ({ default: () => null }));

import HomePage from '@/app/page';
import { clearTtlCache } from '@/lib/ttl-cache';

beforeEach(() => {
  clearTtlCache();
  getRecentPulls.mockClear();
});

describe('HomePage feed read', () => {
  it('back-to-back renders share one feed fetch', async () => {
    await HomePage();
    await HomePage();
    await HomePage();

    expect(getRecentPulls).toHaveBeenCalledTimes(1);
    // Still the global feed — no pack scope, no tier.
    expect(getRecentPulls).toHaveBeenCalledWith();
  });

  it('fetches again once the window has passed', async () => {
    vi.useFakeTimers();
    try {
      await HomePage();
      vi.advanceTimersByTime(5_001);
      await HomePage();
    } finally {
      vi.useRealTimers();
    }

    expect(getRecentPulls).toHaveBeenCalledTimes(2);
  });
});
