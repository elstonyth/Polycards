// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTtlCache } from '@/lib/ttl-cache';

// Only the home preview reads this route, so with its switch off it is not
// there at all.

const getPackTiers = vi.fn(async (slug: string) =>
  slug === '151' ? { tiers: [] } : null,
);
vi.mock('@/lib/data/packs', () => ({ getPackTiers }));

const { GET } = await import('../route');
const call = (slug: string) =>
  GET(new Request(`http://localhost/api/pack-tiers/${slug}`), {
    params: Promise.resolve({ slug }),
  });

afterEach(() => {
  vi.unstubAllEnvs();
  getPackTiers.mockClear();
  clearTtlCache();
});

describe('/api/pack-tiers/<slug>', () => {
  it('switch off: 404, and no pack read', async () => {
    vi.stubEnv('HOME_PREVIEW', '');
    expect((await call('151')).status).toBe(404);
    expect(getPackTiers).not.toHaveBeenCalled();
  });

  it("switch on: the pack's tiers, and 404 for a pack it does not know", async () => {
    vi.stubEnv('HOME_PREVIEW', '1');
    const res = await call('151');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tiers: [] });
    expect((await call('nope')).status).toBe(404);
  });
});
