import { describe, it, expect, vi, beforeEach } from 'vitest';

// challenge.ts imports @/lib/medusa (sdk) and @/lib/logger — mock both. The real
// parseOne/ChallengeSchema, rm0, and avatarForSeed run, so schema validation +
// formatting are genuine.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: fetchMock } } }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getChallenge, formatReset } from '@/lib/data/challenge';

describe('formatReset', () => {
  it('formats a Monday 00:00 Asia/Kuala_Lumpur reset', () => {
    expect(formatReset(1, 0, 'Asia/Kuala_Lumpur')).toBe(
      'Resets Mondays 00:00 (MYT)',
    );
  });

  it('pads the hour and maps Sunday=0..Saturday=6', () => {
    expect(formatReset(0, 9, 'UTC')).toBe('Resets Sundays 09:00 (UTC)');
    expect(formatReset(6, 23, 'UTC')).toBe('Resets Saturdays 23:00 (UTC)');
  });

  it('falls back to the raw IANA name for an unknown zone', () => {
    expect(formatReset(1, 0, 'America/New_York')).toBe(
      'Resets Mondays 00:00 (America/New_York)',
    );
  });
});

describe('getChallenge', () => {
  beforeEach(() => fetchMock.mockReset());

  const active = {
    active: true,
    progress: { pooledMyr: 750 },
    settings: {
      timezone: 'Asia/Kuala_Lumpur',
      resetDay: 1,
      resetHour: 0,
    },
    stages: [
      {
        stageNumber: 1,
        thresholdMyr: 500,
        // Sparse per-rank table: #1 card-only, #4 credits-only.
        rankRewards: [
          { rank: 1, cardId: 'c1', credits: 0 },
          { rank: 4, cardId: null, credits: 50 },
        ],
      },
      {
        stageNumber: 2,
        thresholdMyr: 1000,
        // Same prize card as stage 1 — the summary must dedupe it.
        rankRewards: [
          { rank: 1, cardId: 'c1', credits: 0 },
          { rank: 4, cardId: null, credits: 100 },
        ],
      },
      {
        stageNumber: 3,
        thresholdMyr: 2000,
        rankRewards: [{ rank: 4, cardId: null, credits: 200 }],
      },
    ],
    cards: {
      c1: {
        name: 'Charizard',
        image: 'http://x/charizard.webp',
        slab_image: 'http://x/charizard-slab.webp',
      },
      c2: { name: 'Pikachu', image: 'http://x/pikachu.webp' },
      c3: { name: 'Mewtwo', image: 'http://x/mewtwo.webp' },
      // Distinct id, SAME image as c1 — the summary must NOT collapse these.
      dup: {
        name: 'Alt Charizard',
        image: 'http://x/charizard.webp',
        slabImage: null,
      },
    },
    top: [
      {
        rank: 1,
        name: 'Ash',
        handle: 'ash-1234',
        volumeMyr: 600,
        pulls: 4,
        seed: 42,
        avatar_url: null,
      },
      {
        rank: 2,
        name: 'Collector 99',
        handle: null,
        volumeMyr: 150,
        pulls: 1,
        seed: 99,
        avatar_url: 'http://x/avatar.png',
      },
    ],
  };

  it('maps an active challenge, formatting RM and resolving cards', async () => {
    fetchMock.mockResolvedValueOnce(active);
    const c = await getChallenge();
    expect(c).not.toBeNull();
    expect(c!.resetLabel).toBe('Resets Mondays 00:00 (MYT)');
    expect(c!.stages[0]).toMatchObject({
      threshold: 'RM 500',
      thresholdCompact: 'RM 500',
      reward: 'RM 50',
    });
    expect(c!.stages[0]!.rankRewards).toEqual([
      {
        rank: 1,
        card: {
          name: 'Charizard',
          image: 'http://x/charizard.webp',
          slabImage: 'http://x/charizard-slab.webp',
        },
        credits: 0,
        creditsLabel: null,
      },
      { rank: 4, card: null, credits: 50, creditsLabel: 'RM 50' },
    ]);
  });

  it('lists every configured rank 1-10, sorted, with card and/or credits', async () => {
    fetchMock.mockResolvedValueOnce({
      ...active,
      stages: [
        {
          stageNumber: 1,
          thresholdMyr: 500,
          rankRewards: [
            // Deliberately out of order; rank 7 pays BOTH; rank 9 pays nothing
            // (no card, no credits) and must be omitted entirely.
            { rank: 10, cardId: null, credits: 5 },
            { rank: 9, cardId: null, credits: 0 },
            { rank: 7, cardId: 'c3', credits: 25 },
            { rank: 1, cardId: 'c1', credits: 0 },
          ],
        },
        ...active.stages.slice(1),
      ],
    });
    const c = await getChallenge();
    expect(c!.stages[0]!.rankRewards).toEqual([
      {
        rank: 1,
        card: {
          name: 'Charizard',
          image: 'http://x/charizard.webp',
          slabImage: 'http://x/charizard-slab.webp',
        },
        credits: 0,
        creditsLabel: null,
      },
      {
        rank: 7,
        card: {
          name: 'Mewtwo',
          image: 'http://x/mewtwo.webp',
          slabImage: null,
        },
        credits: 25,
        creditsLabel: 'RM 25',
      },
      { rank: 10, card: null, credits: 5, creditsLabel: 'RM 5' },
    ]);
    // `reward` is the SUM of credits across ranks 4-10 (25 + 5), not a
    // per-winner figure — the sheet breaks it down per rank.
    expect(c!.stages[0]!.reward).toBe('RM 30');
  });

  it('derives pool stats and stage states from the real pool', async () => {
    // pool 750: stage 1 (500) complete, stage 2 (1000) active, stage 3 locked.
    fetchMock.mockResolvedValueOnce(active);
    const c = await getChallenge();
    expect(c!.pool).toEqual({
      pooled: 'RM 750',
      topThreshold: 'RM 2,000',
      overallPct: 37.5, // 750 / 2000
      next: { stageNumber: 2, threshold: 'RM 1,000', remaining: 'RM 250' },
    });
    expect(c!.stages.map((s) => s.state)).toEqual([
      'complete',
      'active',
      'locked',
    ]);
    // Marker positions: threshold / top threshold.
    expect(c!.stages.map((s) => s.pct)).toEqual([25, 50, 100]);
    expect(c!.stages[2]!.thresholdCompact).toBe('RM 2K');
  });

  it('accumulates the Rewards Summary from unlocked stages only', async () => {
    fetchMock.mockResolvedValueOnce(active);
    const c = await getChallenge();
    expect(c!.summary).toEqual({
      unlockedCount: 1,
      cards: [
        {
          name: 'Charizard',
          image: 'http://x/charizard.webp',
          slabImage: 'http://x/charizard-slab.webp',
        },
      ],
      credits: 'RM 50',
    });
  });

  it('marks every stage complete and sums all credits when cleared', async () => {
    fetchMock.mockResolvedValueOnce({
      ...active,
      progress: { pooledMyr: 5000 },
    });
    const c = await getChallenge();
    expect(c!.pool).toMatchObject({ overallPct: 100, next: null });
    expect(c!.stages.every((s) => s.state === 'complete')).toBe(true);
    expect(c!.summary).toMatchObject({
      unlockedCount: 3,
      credits: 'RM 350', // 50 + 100 + 200
    });
    // c1 is featured by BOTH stage 1 and stage 2 — one thumb, not two.
    expect(c!.summary!.cards).toEqual([
      {
        name: 'Charizard',
        image: 'http://x/charizard.webp',
        slabImage: 'http://x/charizard-slab.webp',
      },
    ]);
  });

  it('maps the Weekly Pull Value top list (avatar fallback + override)', async () => {
    fetchMock.mockResolvedValueOnce(active);
    const c = await getChallenge();
    expect(c!.top).toHaveLength(2);
    expect(c!.top[0]).toMatchObject({
      rank: 1,
      name: 'Ash',
      handle: 'ash-1234',
      volume: 'RM 600',
    });
    // seed-derived fallback when avatar_url is null; override wins otherwise.
    expect(typeof c!.top[0]!.avatar).toBe('string');
    expect(c!.top[0]!.avatar.length).toBeGreaterThan(0);
    expect(c!.top[1]!.avatar).toBe('http://x/avatar.png');
  });

  it('returns null pool/summary (and null states) when the backend sends no progress', async () => {
    const { progress: _progress, top: _top, ...rest } = active;
    fetchMock.mockResolvedValueOnce(rest);
    const c = await getChallenge();
    expect(c).not.toBeNull();
    expect(c!.pool).toBeNull();
    expect(c!.summary).toBeNull();
    expect(c!.top).toEqual([]);
    expect(c!.stages.every((s) => s.state === null)).toBe(true);
  });

  it('returns null when the challenge is off (active:false)', async () => {
    fetchMock.mockResolvedValueOnce({ ...active, active: false });
    expect(await getChallenge()).toBeNull();
  });

  it('returns null when the backend is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await getChallenge()).toBeNull();
  });

  it('preserves every rank 1-10 when a higher-rank card is unresolvable', async () => {
    // #1's card id is missing and it pays no credits → the ROW drops, and every
    // other rank must keep its own numeral instead of shifting up.
    fetchMock.mockResolvedValueOnce({
      ...active,
      stages: [
        {
          ...active.stages[0],
          rankRewards: [
            { rank: 1, cardId: 'missing', credits: 0 },
            { rank: 2, cardId: 'c2', credits: 0 },
            { rank: 3, cardId: 'c3', credits: 0 },
            ...[4, 5, 6, 7, 8, 9, 10].map((rank) => ({
              rank,
              cardId: null,
              credits: rank,
            })),
          ],
        },
        ...active.stages.slice(1),
      ],
    });
    const c = await getChallenge();
    const rows = c!.stages[0]!.rankRewards;
    expect(rows.map((r) => r.rank)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows[0]).toEqual({
      rank: 2,
      card: {
        name: 'Pikachu',
        image: 'http://x/pikachu.webp',
        slabImage: null,
      },
      credits: 0,
      creditsLabel: null,
    });
    expect(rows[1]!.card).toEqual({
      name: 'Mewtwo',
      image: 'http://x/mewtwo.webp',
      slabImage: null,
    });
  });

  it('keeps a rank whose card is unresolvable but which still pays credits', async () => {
    fetchMock.mockResolvedValueOnce({
      ...active,
      stages: [
        {
          ...active.stages[0],
          rankRewards: [{ rank: 2, cardId: 'missing', credits: 40 }],
        },
        ...active.stages.slice(1),
      ],
    });
    const c = await getChallenge();
    expect(c!.stages[0]!.rankRewards).toEqual([
      { rank: 2, card: null, credits: 40, creditsLabel: 'RM 40' },
    ]);
  });

  it('dedupes the summary by card id, not image', async () => {
    // Stage 1 features c1 and `dup` (distinct ids, identical image). Both are
    // real prizes, so the summary shows TWO cards — an image-keyed dedupe would
    // wrongly collapse them to one.
    fetchMock.mockResolvedValueOnce({
      ...active,
      progress: { pooledMyr: 5000 },
      stages: [
        {
          ...active.stages[0],
          rankRewards: [
            { rank: 1, cardId: 'c1', credits: 0 },
            { rank: 2, cardId: 'dup', credits: 0 },
            { rank: 3, cardId: 'c1', credits: 0 },
          ],
        },
        ...active.stages.slice(1),
      ],
    });
    const c = await getChallenge();
    // c1 (repeated) collapses to one; dup survives as its own card.
    expect(c!.summary!.cards).toEqual([
      {
        name: 'Charizard',
        image: 'http://x/charizard.webp',
        slabImage: 'http://x/charizard-slab.webp',
      },
      {
        name: 'Alt Charizard',
        image: 'http://x/charizard.webp',
        slabImage: null,
      },
    ]);
  });

  // --- graceful degradation: one bad section must not blank the challenge block ----

  it('drops a malformed stage row and keeps the survivors', async () => {
    // Corrupt the middle stage — a null `thresholdMyr` fails `finite`.
    fetchMock.mockResolvedValueOnce({
      ...active,
      stages: [
        active.stages[0],
        { ...active.stages[1], thresholdMyr: null },
        active.stages[2],
      ],
    });
    const c = await getChallenge();
    expect(c).not.toBeNull();
    expect(c!.stages).toHaveLength(2); // survivors, not a blanked page
    expect(c!.stages.map((s) => s.stageNumber)).toEqual([1, 3]);
    expect(c!.stages[0]).toMatchObject({
      threshold: 'RM 500',
      reward: 'RM 50',
    });
  });

  it('drops a malformed top-standings row and keeps the survivors', async () => {
    fetchMock.mockResolvedValueOnce({
      ...active,
      top: [active.top[0], { ...active.top[1], volumeMyr: null }],
    });
    const c = await getChallenge();
    expect(c).not.toBeNull();
    expect(c!.top).toHaveLength(1);
    expect(c!.top[0]).toMatchObject({ rank: 1, name: 'Ash' });
  });

  it('drops a malformed card entry without blanking the challenge', async () => {
    fetchMock.mockResolvedValueOnce({
      ...active,
      cards: { ...active.cards, bad: { name: 5, image: null } },
    });
    const c = await getChallenge();
    expect(c).not.toBeNull();
    // The valid card still resolves for the stage that references it.
    expect(c!.stages[0]!.rankRewards[0]).toEqual({
      rank: 1,
      card: {
        name: 'Charizard',
        image: 'http://x/charizard.webp',
        slabImage: 'http://x/charizard-slab.webp',
      },
      credits: 0,
      creditsLabel: null,
    });
  });

  it('drops a malformed RANK ROW without dropping the stage', async () => {
    fetchMock.mockResolvedValueOnce({
      ...active,
      stages: [
        {
          ...active.stages[0],
          rankRewards: [
            { rank: 1, cardId: 'c1', credits: 0 },
            { rank: 'two', cardId: 'c2', credits: 0 }, // malformed rank
            { rank: 4, cardId: null, credits: 50 },
          ],
        },
        ...active.stages.slice(1),
      ],
    });
    const c = await getChallenge();
    expect(c!.stages).toHaveLength(3);
    expect(c!.stages[0]!.rankRewards.map((r) => r.rank)).toEqual([1, 4]);
  });

  it('renders a stage with no rankRewards field (older backend)', async () => {
    const { rankRewards: _drop, ...stage1 } = active.stages[0]!;
    fetchMock.mockResolvedValueOnce({
      ...active,
      stages: [stage1, ...active.stages.slice(1)],
    });
    const c = await getChallenge();
    expect(c!.stages).toHaveLength(3);
    expect(c!.stages[0]!.rankRewards).toEqual([]);
    expect(c!.stages[0]!.reward).toBe('RM 0');
  });

  it('degrades a malformed progress section to absent (stages still render)', async () => {
    fetchMock.mockResolvedValueOnce({
      ...active,
      progress: { pooledMyr: 'not-a-number' },
    });
    const c = await getChallenge();
    expect(c).not.toBeNull();
    expect(c!.pool).toBeNull();
    expect(c!.summary).toBeNull();
    expect(c!.stages).toHaveLength(3);
    expect(c!.stages.every((s) => s.state === null)).toBe(true);
  });
});
