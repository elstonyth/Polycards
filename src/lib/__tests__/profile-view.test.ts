import { describe, it, expect } from 'vitest';
import { toProfileView } from '@/lib/profile-view';
import type { PublicProfile } from '@/lib/data/profiles';

describe('toProfileView — tolerates a missing recent array', () => {
  it('does not throw and yields empty activity when recent is absent', () => {
    // PublicProfileSchema is intentionally loose (handle + stats), so a
    // regressed/absent `recent` must degrade gracefully here (empty activity),
    // not crash the async server component with a `.map of undefined` 500.
    const profile = {
      name: 'Ash',
      seed: 1,
      joined_at: '2026-01-01T00:00:00Z',
      stats: { points: 0, pulls: 0, volume: 0 },
      collection: [],
      // `recent` deliberately omitted
    } as unknown as PublicProfile;

    const view = toProfileView(profile);
    expect(view.activity).toEqual([]);
    expect(view.username).toBe('Ash');
  });
});
