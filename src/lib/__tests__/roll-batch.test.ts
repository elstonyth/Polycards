import { describe, expect, it, vi } from 'vitest';
import {
  rollBatch,
  rollBlocker,
  rollMode,
  type RollDeps,
  type RollRequest,
} from '../roll-batch';
import { FLAT_BUYBACK_PERCENT, type PackCard } from '@/lib/packs-data';
import { SELL_COUNTDOWN_SECS } from '@/lib/sell-countdown';
import type { WonCard } from '@/lib/actions/packs';

// One roll batch, four routes. What these pin is the money path: which route a
// press takes, that exactly ONE server call is made (never a retry, because the
// charge may already have landed), that a free rip still gets a real flat-rate
// offer, and — the invariant with no other unit expression — that a demo Spin
// issues ZERO server calls.

const card = (id: string): PackCard => ({
  id,
  name: id,
  image: `/x/${id}.webp`,
  slabImage: null,
  value: 'RM 10.00',
  rarity: 'Common',
});

const won = (id: string, marketPriceMyr: number | null = 20): WonCard => ({
  id,
  name: id,
  image: `/x/${id}.webp`,
  slab_image: null,
  value: 'RM 20.00',
  rarity: 'Rare',
  pokemon_dex: null,
  sprite_image: null,
  marketPriceMyr,
});

/** Spies for all three server routes, so "was anything called" is assertable. */
function deps(over: Partial<RollDeps> = {}) {
  return {
    openBatch: vi.fn(async () => ({
      ok: true as const,
      rolls: [],
      price: 0,
      total: 0,
      balance: null,
    })),
    openPack: vi.fn(async () => ({
      ok: false as const,
      error: 'nope',
    })),
    spinTaskReward: vi.fn(async () => ({
      ok: false as const,
      error: 'nope',
    })),
    now: () => 1_000_000,
    random: () => 0.999,
    ...over,
  } satisfies RollDeps as RollDeps & {
    openBatch: ReturnType<typeof vi.fn>;
    openPack: ReturnType<typeof vi.fn>;
    spinTaskReward: ReturnType<typeof vi.fn>;
  };
}

const req = (over: Partial<RollRequest> = {}): RollRequest => ({
  mode: 'paid',
  packId: 'bronze',
  reels: 1,
  freeRipClaimId: null,
  demoPool: [],
  demoOdds: [{ rarity: 'Common', chance: '100%' }],
  forId: 'cus_1',
  ...over,
});

describe('rollMode', () => {
  it('gives a GUEST on ?demo=1 the demo, over every other route', () => {
    expect(
      rollMode({
        demoPool: [card('a')],
        signedIn: false,
        freeRipClaimId: 'claim_1',
        freeWelcome: true,
      }),
    ).toBe('demo');
  });

  it('gives a signed-in customer on ?demo=1 the real machine', () => {
    expect(
      rollMode({
        demoPool: [card('a')],
        signedIn: true,
        freeRipClaimId: null,
        freeWelcome: false,
      }),
    ).toBe('paid');
  });

  it('prefers a free rip over the free welcome pack', () => {
    expect(
      rollMode({
        demoPool: null,
        signedIn: true,
        freeRipClaimId: 'claim_1',
        freeWelcome: true,
      }),
    ).toBe('free-rip');
  });

  it('treats an empty claim id as no free rip', () => {
    expect(
      rollMode({
        demoPool: null,
        signedIn: true,
        freeRipClaimId: '',
        freeWelcome: true,
      }),
    ).toBe('free-pack');
  });
});

describe('rollBlocker', () => {
  it('blocks only an empty demo pool', () => {
    expect(rollBlocker(req({ mode: 'demo', demoPool: [] }))).toMatch(
      /No cards in this pack/,
    );
    expect(
      rollBlocker(req({ mode: 'demo', demoPool: [card('a')] })),
    ).toBeNull();
    expect(rollBlocker(req({ mode: 'paid' }))).toBeNull();
    expect(rollBlocker(req({ mode: 'free-pack' }))).toBeNull();
  });
});

describe('rollBatch — demo Spin', () => {
  it('issues ZERO server calls', async () => {
    const d = deps();
    const res = await rollBatch(
      req({ mode: 'demo', reels: 3, demoPool: [card('a')] }),
      d,
    );

    expect(res.ok).toBe(true);
    expect(d.openBatch).not.toHaveBeenCalled();
    expect(d.openPack).not.toHaveBeenCalled();
    expect(d.spinTaskReward).not.toHaveBeenCalled();
  });

  it('draws one card per reel, all unsellable and uncharged', async () => {
    const res = await rollBatch(
      req({ mode: 'demo', reels: 3, demoPool: [card('a'), card('b')] }),
      deps(),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.batch.cards).toHaveLength(3);
    // One offer slot per card, every one null — a short array would leave the
    // sell window seeding fewer per-card states than there are cards.
    expect(res.batch.offers).toEqual([null, null, null]);
    expect(res.batch.balance).toBeNull();
    expect(res.batch.locked).toBe(false);
    expect(res.batch.mode).toBe('demo');
  });
});

describe('a demo batch is bound to no account', () => {
  it('pins forId to null even when the request carries one', async () => {
    // The settle guard tests `forId !== null`, so this is what makes "a demo
    // belongs to nobody" structural rather than a coincidence of the one call
    // site that happens to build demo requests only while signed out. A
    // hand-built request must not be able to produce an account-bound demo.
    const res = await rollBatch(
      req({ mode: 'demo', demoPool: [card('a')], forId: 'cus_someone_else' }),
      deps(),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.batch.forId).toBeNull();
  });

  it('still carries the account on every paid route', async () => {
    const d = deps();
    const res = await rollBatch(req({ mode: 'paid', forId: 'cus_1' }), d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.batch.forId).toBe('cus_1');
  });
});

describe('rollBatch — free rip', () => {
  const redeemed = {
    ok: true as const,
    redeemed: true as const,
    pullId: 'pull_1',
    card: won('charizard'),
    marketValue: 5,
  };

  it('spends the entitlement once and never batches, even at 3 reels', async () => {
    const spinTaskReward = vi.fn(async () => redeemed);
    const d = deps({ spinTaskReward });

    const res = await rollBatch(
      req({ mode: 'free-rip', reels: 3, freeRipClaimId: 'claim_1' }),
      d,
    );

    expect(spinTaskReward).toHaveBeenCalledTimes(1);
    expect(spinTaskReward).toHaveBeenCalledWith('claim_1');
    expect(d.openBatch).not.toHaveBeenCalled();
    expect(d.openPack).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.batch.cards).toHaveLength(1);
  });

  it('still quotes a REAL flat-rate offer — `locked` is what hides the sell', async () => {
    const res = await rollBatch(
      req({ mode: 'free-rip', freeRipClaimId: 'claim_1' }),
      deps({ spinTaskReward: vi.fn(async () => redeemed) }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const offer = res.batch.offers[0];
    expect(offer).not.toBeNull();
    expect(offer?.pullId).toBe('pull_1');
    expect(offer?.percent).toBe(FLAT_BUYBACK_PERCENT);
    expect(offer?.amount).toBe(
      Math.round(20 * FLAT_BUYBACK_PERCENT) / 100, // 20 MYR FMV at the flat rate
    );
    expect(offer?.instantDeadlineMs).toBe(
      1_000_000 + SELL_COUNTDOWN_SECS * 1000,
    );
    expect(res.batch.locked).toBe(true);
    expect(res.batch.balance).toBeNull();
  });

  it('reports an already-redeemed claim as a rejection, with no second call', async () => {
    const spinTaskReward = vi.fn(async () => ({
      ok: true as const,
      redeemed: false as const,
      reason: 'already_redeemed' as const,
    }));

    const res = await rollBatch(
      req({ mode: 'free-rip', freeRipClaimId: 'claim_1' }),
      deps({ spinTaskReward }),
    );

    expect(spinTaskReward).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: false, kind: 'rejected' });
    if (res.ok || res.kind !== 'rejected') return;
    expect(res.error).toMatch(/already spun/);
  });
});

describe('free rip with no claim id', () => {
  it('refuses without calling the server', async () => {
    // Unreachable past rollMode, but a coalesce to '' here would spend a
    // REQUEST carrying an empty entitlement rather than refusing.
    const d = deps();
    const res = await rollBatch(
      req({ mode: 'free-rip', freeRipClaimId: null }),
      d,
    );

    expect(res.ok).toBe(false);
    expect(d.spinTaskReward).not.toHaveBeenCalled();
    expect(d.openBatch).not.toHaveBeenCalled();
    expect(d.openPack).not.toHaveBeenCalled();
  });
});

describe('rollBatch — free welcome pack', () => {
  it('uses the single-open route once, never the batch route', async () => {
    const openPack = vi.fn(async () => ({
      ok: true as const,
      card: won('pikachu'),
      pullId: 'pull_2',
      marketValue: 5,
      buyback: null,
      balance: 42,
      price: 0,
      free: true,
      locked: true,
    }));
    const d = deps({ openPack });

    const res = await rollBatch(req({ mode: 'free-pack', reels: 3 }), d);

    expect(openPack).toHaveBeenCalledTimes(1);
    expect(openPack).toHaveBeenCalledWith('bronze');
    expect(d.openBatch).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.batch.cards).toHaveLength(1);
    expect(res.batch.balance).toBe(42);
    // Read off the response, never derived from "it was free".
    expect(res.batch.locked).toBe(true);
  });
});

describe('rollBatch — paid open', () => {
  it('passes the reel count through and maps every roll', async () => {
    const openBatch = vi.fn(async () => ({
      ok: true as const,
      rolls: [
        {
          card: won('a'),
          pullId: 'pull_a',
          marketValue: 1,
          buyback: {
            percent: 80,
            amount: 16,
            vaultPercent: 70,
            vaultAmount: 14,
            instantDeadlineMs: 555,
            firm: false,
          },
        },
        { card: won('b'), pullId: null, marketValue: 1, buyback: null },
      ],
      price: 10,
      total: 20,
      balance: 7,
    }));

    const res = await rollBatch(
      req({ mode: 'paid', reels: 2 }),
      deps({ openBatch }),
    );

    expect(openBatch).toHaveBeenCalledTimes(1);
    expect(openBatch).toHaveBeenCalledWith('bronze', 2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.batch.cards.map((c) => c.id)).toEqual(['a', 'b']);
    // Quoted offer wins over the flat fallback; a pull-less roll gets none.
    expect(res.batch.offers[0]).toMatchObject({
      percent: 80,
      amount: 16,
      instantDeadlineMs: 555,
      firm: false,
    });
    expect(res.batch.offers[1]).toBeNull();
    expect(res.batch.balance).toBe(7);
    expect(res.batch.locked).toBe(false);
    expect(res.batch.forId).toBe('cus_1');
  });

  it('reports a rejection once — a possible debit is never retried', async () => {
    const openBatch = vi.fn(async () => ({
      ok: false as const,
      error: 'Not enough credits to open this pack.',
      needsTopUp: true,
    }));

    const res = await rollBatch(req({ mode: 'paid' }), deps({ openBatch }));

    expect(openBatch).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      ok: false,
      kind: 'rejected',
      needsTopUp: true,
    });
  });

  it('turns a transport throw into `unreachable` without re-calling', async () => {
    const openBatch = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await rollBatch(req({ mode: 'paid' }), deps({ openBatch }));

    expect(openBatch).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: false, kind: 'unreachable' });
    errorLog.mockRestore();
  });
});
