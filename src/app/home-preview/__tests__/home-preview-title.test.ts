// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

// A load onto a pack's own address under the preview switch shows the flow
// page, whose tab carries that pack's title as the pack page's does.

const base = {
  pack: { id: '151', name: '151', categoryName: 'Pokemon' },
  siblings: [],
};
const getPackBaseForViewer = vi.fn(async (slug: string) =>
  slug === '151' ? base : null,
);
vi.mock('@/lib/data/packs', () => ({
  getPackBaseForViewer,
  getPackCategories: async () => [],
  getPackHighlights: async () => null,
  getRecentPulls: async () => [],
}));

vi.mock('@/lib/data/leaderboard', () => ({ getLeaderboard: async () => [] }));
vi.mock('@/lib/data/free-pack', () => ({ getFreePackPromo: async () => null }));

const { generateMetadata } = await import('../page');
const title = async (search: Record<string, string>) =>
  (await generateMetadata({ searchParams: Promise.resolve(search) })).title;

afterEach(() => {
  vi.unstubAllEnvs();
  getPackBaseForViewer.mockClear();
});

describe('the flow page title', () => {
  it("a pack's own address: the pack page's title", async () => {
    vi.stubEnv('HOME_PREVIEW', '1');
    expect(await title({ focus: '151' })).toBe('151 — Pokemon');
  });

  it('the preview itself, or a pack it cannot find: the preview title', async () => {
    vi.stubEnv('HOME_PREVIEW', '1');
    expect(await title({})).toBe('Home preview');
    expect(await title({ focus: 'nope' })).toBe('Pack');
  });

  it('switch off: reads no pack', async () => {
    vi.stubEnv('HOME_PREVIEW', '');
    expect(await title({ focus: '151' })).toBe('Home preview');
    expect(getPackBaseForViewer).not.toHaveBeenCalled();
  });
});
