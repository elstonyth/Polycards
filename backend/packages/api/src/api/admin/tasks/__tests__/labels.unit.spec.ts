import { resolveTaskLabels, resolveTaskViews } from '../labels';
import type PacksModuleService from '../../../../modules/packs/service';

// A stub with only the three readers resolveTaskLabels touches. Enough to pin
// the formatting AND the batching contract — the console's whole reason for
// asking the server is that it must not fetch these catalogs itself, so a
// regression that started listing everything should fail here.
const calls = { packs: 0, cards: 0, pixel: 0 };
const stub = {
  listPacks: async (sel: { slug: string[] }) => {
    calls.packs++;
    return sel.slug
      .filter((s) => s !== 'gone-pack')
      .map((slug) => ({ slug, title: `Pack ${slug}` }));
  },
  listCards: async (sel: { handle: string[] }) => {
    calls.cards++;
    return sel.handle.map((handle) => ({
      handle,
      name: `Card ${handle}`,
      grader: 'PSA',
      grade: '10',
    }));
  },
  // SINGULAR on purpose: this is the name the module exposes at runtime.
  // Mocking the pluralized generated-type name made this suite pass while the
  // real console 500'd on any task carrying a pixel_pokemon_id.
  listPixelPokemon: async (sel: { id: string[] }) => {
    calls.pixel++;
    return sel.id.map((id) => ({ id, name: 'Pikachu', dex: 25 }));
  },
} as unknown as PacksModuleService;

const row = (
  id: string,
  requirement: Record<string, unknown>,
  reward: Record<string, unknown>,
) => ({ id, requirement, reward });

beforeEach(() => {
  calls.packs = 0;
  calls.cards = 0;
  calls.pixel = 0;
});

describe('resolveTaskLabels', () => {
  it('a tickets reward reads as its count, with no " + N tickets" on top', async () => {
    const goal = { type: 'checkin_days', days: 1 };
    const reward = { type: 'tickets' };
    const out = await resolveTaskLabels(stub, [
      { ...row('a', goal, reward), tickets: 50 },
      { ...row('b', goal, reward), tickets: 1 },
    ]);
    expect(out.get('a')!.reward).toBe('50 Lucky Draw tickets');
    expect(out.get('b')!.reward).toBe('1 Lucky Draw ticket');
  });

  it('reads every requirement type as a sentence, singular and plural', async () => {
    const out = await resolveTaskLabels(stub, [
      row('a', { type: 'checkin_days', days: 1 }, { type: 'credit', amount_myr: 5 }),
      row('b', { type: 'checkin_days', days: 3 }, { type: 'credit', amount_myr: 5 }),
      row('c', { type: 'rip_count', count: 3, pack_id: null }, { type: 'credit', amount_myr: 1 }),
      row('d', { type: 'reach_level', level: 20 }, { type: 'credit', amount_myr: 1 }),
      row('e', { type: 'vault_count', count: 1 }, { type: 'credit', amount_myr: 1 }),
      row('f', { type: 'vault_pixel_count', count: 3 }, { type: 'credit', amount_myr: 1 }),
    ]);
    expect(out.get('a')!.requirement).toBe('Check in on 1 day this week');
    expect(out.get('b')!.requirement).toBe('Check in on 3 days this week');
    expect(out.get('c')!.requirement).toBe('Rip 3 packs this week');
    expect(out.get('d')!.requirement).toBe('Reach VIP level 20');
    expect(out.get('e')!.requirement).toBe('Vault 1 card');
    expect(out.get('f')!.requirement).toBe('Vault 3 Pokémon (pixel) cards');
  });

  it('names the scoped pack and Pokémon instead of printing a slug or a ULID', async () => {
    const out = await resolveTaskLabels(stub, [
      row(
        'a',
        { type: 'rip_count', count: 2, pack_id: 'bronze' },
        { type: 'pack', pack_id: 'gold' },
      ),
      row(
        'b',
        { type: 'vault_pixel_count', count: 3, pixel_pokemon_id: 'px_1' },
        { type: 'card', card_handle: 'charizard' },
      ),
    ]);
    expect(out.get('a')!.requirement).toBe('Rip 2 × Pack bronze this week');
    expect(out.get('a')!.reward).toBe('Free rip · Pack gold');
    expect(out.get('b')!.requirement).toBe('Vault 3 × #25 Pikachu');
    expect(out.get('b')!.reward).toBe('Card · Card charizard · PSA 10');
  });

  it('marks a dangling reference rather than hiding it', async () => {
    // This task will fail at claim time for every customer who completes it,
    // so the console must not render it as if it were fine.
    const out = await resolveTaskLabels(stub, [
      row('a', { type: 'checkin_days', days: 1 }, { type: 'pack', pack_id: 'gone-pack' }),
    ]);
    expect(out.get('a')!.reward).toBe('Free rip · gone-pack (missing)');
  });

  it('formats credit as money', async () => {
    const out = await resolveTaskLabels(stub, [
      row('a', { type: 'checkin_days', days: 1 }, { type: 'credit', amount_myr: 5 }),
      row('b', { type: 'checkin_days', days: 1 }, { type: 'credit', amount_myr: 12.5 }),
    ]);
    expect(out.get('a')!.reward).toBe('RM 5.00 bonus credit');
    expect(out.get('b')!.reward).toBe('RM 12.50 bonus credit');
  });

  it('batches one lookup per catalog no matter how many tasks reference it', async () => {
    await resolveTaskLabels(stub, [
      row('a', { type: 'rip_count', count: 1, pack_id: 'bronze' }, { type: 'pack', pack_id: 'gold' }),
      row('b', { type: 'rip_count', count: 2, pack_id: 'silver' }, { type: 'pack', pack_id: 'bronze' }),
    ]);
    expect(calls.packs).toBe(1);
  });

  it('skips a catalog entirely when nothing references it', async () => {
    await resolveTaskLabels(stub, [
      row('a', { type: 'checkin_days', days: 1 }, { type: 'credit', amount_myr: 5 }),
    ]);
    expect(calls.packs).toBe(0);
    expect(calls.cards).toBe(0);
    expect(calls.pixel).toBe(0);
  });

  it('names an unknown type rather than rendering an empty cell', async () => {
    // A row written by a newer build, or straight into the DB. taskProgress
    // fails it closed, so the console should say so too.
    const out = await resolveTaskLabels(stub, [
      row('a', { type: 'from_the_future', count: 3 }, { type: 'mystery' }),
    ]);
    expect(out.get('a')!.requirement).toMatch(/Unknown requirement/);
    expect(out.get('a')!.reward).toMatch(/Unknown reward/);
  });
});

describe('resolveTaskViews', () => {
  const pack = (slug: string, title: string, price: string, over = {}) => ({
    slug,
    title,
    image: `/${slug}.webp`,
    price,
    status: 'active',
    in_stock: true,
    category: 'pokemon',
    ...over,
  });
  const onSaleFilters: unknown[] = [];
  const catalog = {
    listPacks: async (sel: { slug?: string[]; status?: string }) => {
      if (sel.status === 'active') {
        onSaleFilters.push(sel);
        return [{ price: 0 }, { price: 45 }, { price: 20 }, { price: 300 }];
      }
      const all = [
        pack('silver-pack', 'Silver Pack', '600'),
        pack('gold-pack', 'Gold Pack', '1200'),
        pack('draft-pack', 'Draft Pack', '50', { status: 'draft' }),
        pack('sold-pack', 'Sold Pack', '50', { in_stock: false }),
        pack('free-pack', 'Free Pack', '0', { category: 'free_welcome' }),
        pack('box-pack', 'Box Pack', '50', { category: 'reward_box' }),
      ];
      return all.filter((p) => (sel.slug ?? []).includes(p.slug));
    },
    listCards: async () => [
      {
        handle: 'umbreon',
        name: 'Umbreon',
        grader: 'PSA',
        grade: '10',
        market_value: 10,
        market_multiplier: 1,
        image: '/raw.webp',
        slab_image: '/slab.webp',
      },
      {
        handle: 'raw',
        name: 'Raw Card',
        grader: '',
        grade: '',
        market_value: 1,
        market_multiplier: 1,
        image: '/raw2.webp',
        slab_image: null,
      },
    ],
    listPixelPokemon: async () => [
      { id: 'px_151', name: 'Mew', image_url: 'https://cdn/mew.gif', variant: 'normal' },
      { id: 'px_wano', name: 'Luffy', image_url: 'https://cdn/l.gif', variant: 'wano' },
    ],
    retrieveFxRate: async () => 4,
  } as unknown as PacksModuleService;

  it('prices an any-pack goal at the cheapest pack a player can really open', async () => {
    onSaleFilters.length = 0;
    const out = await resolveTaskViews(catalog, [
      {
        id: 'any',
        requirement: { type: 'rip_count', count: 10, pack_id: null },
        reward: { type: 'pack', pack_id: 'silver-pack' },
      },
    ]);
    expect(out.get('any')).toEqual({
      goal_name: null,
      goal_image: null,
      goal_price_myr: 20,
      goal_buyable: null,
      reward_name: 'Silver Pack',
      reward_grade: null,
      reward_image: '/silver-pack.webp',
      reward_value_myr: 600,
    });
    expect(onSaleFilters[0]).toEqual({
      status: 'active',
      in_stock: true,
      category: { $nin: ['reward_box', 'free_welcome'] },
    });
  });

  it('names the pack and Pokémon a goal names, and credit is worth its amount', async () => {
    const out = await resolveTaskViews(catalog, [
      {
        id: 'rip',
        requirement: { type: 'rip_count', count: 2, pack_id: 'gold-pack' },
        reward: { type: 'credit', amount_myr: 50 },
      },
      {
        id: 'pull',
        requirement: {
          type: 'vault_pixel_count',
          count: 2,
          pixel_pokemon_id: 'px_151',
        },
        reward: { type: 'tickets' },
      },
    ]);
    expect(out.get('rip')).toMatchObject({
      goal_name: 'Gold Pack',
      goal_price_myr: 1200,
      goal_buyable: true,
      reward_value_myr: 50,
    });
    expect(out.get('pull')).toMatchObject({
      goal_name: 'Mew',
      goal_image: 'https://cdn/mew.gif',
      goal_price_myr: null,
      goal_buyable: null,
      reward_value_myr: null,
    });
  });

  it('a variant keeps its name apart from the plain sprite', async () => {
    const out = await resolveTaskViews(catalog, [
      {
        id: 'v',
        requirement: {
          type: 'vault_pixel_count',
          count: 1,
          pixel_pokemon_id: 'px_wano',
        },
        reward: { type: 'tickets' },
      },
    ]);
    expect(out.get('v')!.goal_name).toBe('Luffy (wano)');
  });

  it.each(['draft-pack', 'sold-pack', 'free-pack', 'box-pack'])(
    'says a goal on %s cannot be ripped',
    async (slug) => {
      const out = await resolveTaskViews(catalog, [
        {
          id: 'x',
          requirement: { type: 'rip_count', count: 2, pack_id: slug },
          reward: { type: 'credit', amount_myr: 5 },
        },
      ]);
      expect(out.get('x')!.goal_buyable).toBe(false);
    },
  );

  it('a card reward carries its slab, grade and shop value', async () => {
    const out = await resolveTaskViews(catalog, [
      {
        id: 'card',
        requirement: { type: 'checkin_days', days: 3 },
        reward: { type: 'card', card_handle: 'umbreon' },
      },
      {
        id: 'raw',
        requirement: { type: 'checkin_days', days: 4 },
        reward: { type: 'card', card_handle: 'raw' },
      },
    ]);
    expect(out.get('card')).toMatchObject({
      reward_name: 'Umbreon',
      reward_grade: 'PSA 10',
      reward_image: '/slab.webp',
    });
    expect(out.get('card')!.reward_value_myr).toBeGreaterThan(0);
    expect(out.get('raw')).toMatchObject({
      reward_grade: null,
      reward_image: '/raw2.webp',
    });
  });

  it('a deleted target has no name, and no claim about whether it can be ripped', async () => {
    const out = await resolveTaskViews(catalog, [
      {
        id: 'gone',
        requirement: { type: 'rip_count', count: 2, pack_id: 'gone-pack' },
        reward: { type: 'credit', amount_myr: 5 },
      },
    ]);
    expect(out.get('gone')).toMatchObject({
      goal_name: null,
      goal_price_myr: null,
      goal_buyable: null,
    });
  });
});

describe('resolveTaskLabels — a key left behind by an older rule (2026-11-02)', () => {
  it('reads the amount the goal type uses, not a stale days', async () => {
    const out = await resolveTaskLabels(stub, [
      {
        id: 't',
        kind: 'weekly',
        requirement: {
          type: 'vault_pixel_count',
          days: 1,
          count: 2,
          pixel_pokemon_id: null,
        },
        reward: { type: 'tickets' },
        tickets: 20,
      },
    ]);
    expect(out.get('t')!.requirement).toBe(
      'Pull 2 Pokémon (pixel) cards this week',
    );
  });
});

describe('resolveTaskLabels — cadence wording (daily tasks, 2026-10-06)', () => {
  it('says today / this week / lifetime by kind', async () => {
    const credit = { type: 'credit', amount_myr: 1 };
    const out = await resolveTaskLabels(stub, [
      { id: 'a', kind: 'daily', requirement: { type: 'checkin_days', days: 1 }, reward: credit },
      { id: 'b', kind: 'daily', requirement: { type: 'rip_count', count: 1, pack_id: null }, reward: credit },
      { id: 'c', kind: 'daily', requirement: { type: 'vault_pixel_count', count: 2, pixel_pokemon_id: 'px_1' }, reward: credit },
      { id: 'd', kind: 'weekly', requirement: { type: 'vault_pixel_count', count: 3 }, reward: credit },
      { id: 'e', kind: 'achievement', requirement: { type: 'vault_pixel_count', count: 3 }, reward: credit },
      { id: 'f', kind: 'weekly', requirement: { type: 'rip_count', count: 2, pack_id: 'bronze' }, reward: credit },
    ]);
    expect(out.get('a')!.requirement).toBe('Check in today');
    expect(out.get('b')!.requirement).toBe('Rip 1 pack today');
    expect(out.get('c')!.requirement).toBe('Pull 2 × #25 Pikachu today');
    expect(out.get('d')!.requirement).toBe('Pull 3 Pokémon (pixel) cards this week');
    expect(out.get('e')!.requirement).toBe('Vault 3 Pokémon (pixel) cards');
    expect(out.get('f')!.requirement).toBe('Rip 2 × Pack bronze this week');
  });
});

describe('resolveTaskLabels — Lucky Draw tickets (2026-10-24)', () => {
  it('appends the tickets to the reward label, singular for one, nothing for zero', async () => {
    const credit = { type: 'credit', amount_myr: 5 };
    const requirement = { type: 'checkin_days', days: 1 };
    const out = await resolveTaskLabels(stub, [
      { id: 'a', requirement, reward: credit, tickets: 50 },
      { id: 'b', requirement, reward: credit, tickets: 1 },
      { id: 'c', requirement, reward: credit, tickets: 0 },
      { id: 'd', requirement, reward: credit },
      { id: 'e', requirement, reward: { type: 'pack', pack_id: 'gold' }, tickets: 3 },
    ]);
    expect(out.get('a')!.reward).toBe('RM 5.00 bonus credit + 50 Lucky Draw tickets');
    expect(out.get('b')!.reward).toBe('RM 5.00 bonus credit + 1 Lucky Draw ticket');
    expect(out.get('c')!.reward).toBe('RM 5.00 bonus credit');
    expect(out.get('d')!.reward).toBe('RM 5.00 bonus credit');
    expect(out.get('e')!.reward).toBe('Free rip · Pack gold + 3 Lucky Draw tickets');
  });
});

describe('resolveTaskLabels — top-up goals (2026-10-19)', () => {
  it('reads the amount in whole ringgit with the cadence', async () => {
    const credit = { type: 'credit', amount_myr: 1 };
    const out = await resolveTaskLabels(stub, [
      { id: 'a', kind: 'daily', requirement: { type: 'topup_myr', amount_myr: 50 }, reward: credit },
      { id: 'b', kind: 'weekly', requirement: { type: 'topup_myr', amount_myr: 1000 }, reward: credit },
      { id: 'c', kind: 'achievement', requirement: { type: 'topup_myr', amount_myr: 5000 }, reward: credit },
    ]);
    expect(out.get('a')!.requirement).toBe('Top up RM 50 today');
    expect(out.get('b')!.requirement).toBe('Top up RM 1,000 this week');
    expect(out.get('c')!.requirement).toBe('Top up RM 5,000 in total');
  });
});

