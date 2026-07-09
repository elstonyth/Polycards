import type { MedusaContainer } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import { registerCardInvoke } from '../create-card';

jest.mock('../../../api/admin/media/bake-slab', () => ({
  bakeSlabImage: jest.fn().mockResolvedValue(null),
  deleteSlabFile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@medusajs/medusa/core-flows', () => ({
  updateProductsWorkflow: jest.fn(() => ({
    run: jest.fn().mockResolvedValue({}),
  })),
}));
import {
  bakeSlabImage,
  deleteSlabFile,
} from '../../../api/admin/media/bake-slab';
import { updateProductsWorkflow } from '@medusajs/medusa/core-flows';

// The duplicate-registration contract of registerCardInvoke: a product can be
// registered as a gacha card exactly once, and EVERY way a second registration
// loses — the advisory pre-check, or the handle's UNIQUE constraint when two
// requests race past the pre-check together — must surface the same friendly
// DUPLICATE_ERROR, never a raw DB error (which the API layer turns into a 500).

const PRODUCT = {
  id: 'prod_1',
  handle: 'test-card',
  title: 'Test Card',
  status: 'published',
  thumbnail: '/images/test-card.webp',
  images: [],
  metadata: {},
};

const INPUT = {
  product_id: 'prod_1',
  set: 'Base',
  grader: 'PSA',
  grade: '9',
  market_value: 25,
  pokemon_dex: null as number | null,
  sprite_image: null as string | null,
};

const EXISTING_CARD = { id: 'card_1', handle: 'test-card' };

/** Container stub resolving just the modules the duplicate paths touch. */
const buildContainer = (
  packs: Record<string, jest.Mock>,
  warn: jest.Mock = jest.fn(),
) => {
  const modules: Record<string, unknown> = {
    [PACKS_MODULE]: packs,
    [Modules.PRODUCT]: {
      listProducts: jest.fn().mockResolvedValue([PRODUCT]),
    },
    [ContainerRegistrationKeys.LOGGER]: { warn },
    [ContainerRegistrationKeys.QUERY]: {
      graph: jest.fn().mockResolvedValue({
        data: [{ id: 'prod_1', seller: { id: 'sel_1' } }],
      }),
    },
  };
  return {
    resolve: (key: string) => {
      if (!(key in modules)) {
        throw new Error(`unit stub: unexpected container.resolve("${key}")`);
      }
      return modules[key];
    },
  } as unknown as MedusaContainer;
};

const expectDuplicate = async (run: Promise<unknown>) => {
  const err = await run.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(MedusaError);
  expect((err as MedusaError).type).toBe(MedusaError.Types.DUPLICATE_ERROR);
  expect((err as MedusaError).message).toContain('already registered');
};

describe('registerCardInvoke duplicate handling', () => {
  it('rejects via the pre-check when the card already exists (no create attempted)', async () => {
    const packs = {
      listCards: jest.fn().mockResolvedValue([EXISTING_CARD]),
      createCards: jest.fn(),
    };
    await expectDuplicate(
      registerCardInvoke(INPUT, { container: buildContainer(packs) }),
    );
    expect(packs.createCards).not.toHaveBeenCalled();
  });

  it('maps the unique-violation RACE (pre-check passed, insert collided) to the same friendly error', async () => {
    const packs = {
      // 1st call: pre-check sees nothing; 2nd call: the racing winner's row.
      listCards: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([EXISTING_CARD]),
      createCards: jest
        .fn()
        .mockRejectedValue(
          new Error(
            'duplicate key value violates unique constraint "card_handle_unique"',
          ),
        ),
    };
    await expectDuplicate(
      registerCardInvoke(INPUT, { container: buildContainer(packs) }),
    );
    expect(packs.createCards).toHaveBeenCalledTimes(1);
    expect(packs.listCards).toHaveBeenCalledTimes(2);
  });

  it('surfaces the ORIGINAL insert error even when the recovery re-list also fails', async () => {
    // DB-down scenario: createCards throws AND the duplicate probe throws.
    // The probe's failure must never replace the original fault.
    const dbDown = new Error('connection terminated unexpectedly');
    const packs = {
      listCards: jest
        .fn()
        .mockResolvedValueOnce([]) // pre-check passes
        .mockRejectedValueOnce(new Error('still down')),
      createCards: jest.fn().mockRejectedValue(dbDown),
    };
    const warn = jest.fn();
    await expect(
      registerCardInvoke(INPUT, { container: buildContainer(packs, warn) }),
    ).rejects.toBe(dbDown);
    // The discarded probe failure must leave a trail, not vanish.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still down'));
  });

  it('rethrows the ORIGINAL error when the insert fails for any non-duplicate reason', async () => {
    const dbDown = new Error('connection terminated unexpectedly');
    const packs = {
      // Pre-check empty, and the re-list after the failure is empty too —
      // this was NOT a duplicate, so masking it as one would hide a real fault.
      listCards: jest.fn().mockResolvedValue([]),
      createCards: jest.fn().mockRejectedValue(dbDown),
    };
    await expect(
      registerCardInvoke(INPUT, { container: buildContainer(packs) }),
    ).rejects.toBe(dbDown);
  });
});

describe('registerCardInvoke pixel-pokemon inheritance', () => {
  // A container whose product carries the given metadata (for the staged-id
  // paths) — otherwise identical to buildContainer.
  const buildWithProduct = (
    packs: Record<string, jest.Mock>,
    metadata: Record<string, unknown>,
    warn: jest.Mock = jest.fn(),
  ) => {
    const modules: Record<string, unknown> = {
      [PACKS_MODULE]: packs,
      [Modules.PRODUCT]: {
        listProducts: jest.fn().mockResolvedValue([{ ...PRODUCT, metadata }]),
      },
      [ContainerRegistrationKeys.LOGGER]: { warn },
      [ContainerRegistrationKeys.QUERY]: {
        graph: jest
          .fn()
          .mockResolvedValue({
            data: [{ id: 'prod_1', seller: { id: 'sel_1' } }],
          }),
      },
    };
    return {
      resolve: (key: string) => {
        if (!(key in modules)) throw new Error(`unit stub: resolve("${key}")`);
        return modules[key];
      },
    } as unknown as MedusaContainer;
  };

  const happyPacks = (listPixelPokemon: jest.Mock) => ({
    listCards: jest.fn().mockResolvedValue([]),
    listPixelPokemon, // asPixelPokemonCrud casts packs → calls this (runtime-singular)
    createCards: jest
      .fn()
      .mockResolvedValue([{ id: 'card_1', handle: 'test-card' }]),
    deleteCards: jest.fn(),
  });

  it('degrades a since-deleted STAGED id to unlinked (no throw, warns)', async () => {
    const warn = jest.fn();
    const packs = happyPacks(jest.fn().mockResolvedValue([])); // id resolves to nothing
    await registerCardInvoke(
      { ...INPUT, pixel_pokemon_id: undefined }, // inherited from metadata below
      {
        container: buildWithProduct(
          packs,
          { pixel_pokemon_id: 'pp_gone' },
          warn,
        ),
      },
    );
    // Registered UNLINKED — the mirror columns are all null, not a hard failure.
    expect(packs.createCards).toHaveBeenCalledWith([
      expect.objectContaining({
        pixel_pokemon_id: null,
        pokemon_dex: null,
        sprite_image: null,
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pp_gone'));
  });

  it("hard-fails an EXPLICIT picked id that doesn't resolve (NOT_FOUND, no insert)", async () => {
    const packs = happyPacks(jest.fn().mockResolvedValue([]));
    const err = await registerCardInvoke(
      { ...INPUT, pixel_pokemon_id: 'pp_gone' },
      { container: buildWithProduct(packs, {}) },
    ).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MedusaError);
    expect((err as MedusaError).type).toBe(MedusaError.Types.NOT_FOUND);
    expect(packs.createCards).not.toHaveBeenCalled();
  });

  it('rethrows a RUNTIME lookup failure on the staged path (never silently degrades)', async () => {
    // The asPixelPokemonCrud bridge breaking is a runtime fault tsc can't catch —
    // it must surface, not register every inherited card unlinked.
    const boom = new Error('listPixelPokemon is not a function');
    const packs = happyPacks(jest.fn().mockRejectedValue(boom));
    await expect(
      registerCardInvoke(
        { ...INPUT, pixel_pokemon_id: undefined },
        { container: buildWithProduct(packs, { pixel_pokemon_id: 'pp_x' }) },
      ),
    ).rejects.toBe(boom);
    expect(packs.createCards).not.toHaveBeenCalled();
  });
});

describe('registerCardInvoke slab bake', () => {
  beforeEach(() =>
    jest.mocked(bakeSlabImage).mockReset().mockResolvedValue(null),
  );

  const happyPacks = () => ({
    listCards: jest.fn().mockResolvedValue([]),
    createCards: jest
      .fn()
      .mockResolvedValue([{ id: 'card_1', handle: 'test-card' }]),
    deleteCards: jest.fn(),
  });

  it('graded input bakes before insert and stores url + key', async () => {
    jest
      .mocked(bakeSlabImage)
      .mockResolvedValue({ url: '/static/slab-x.webp', key: 'slab-x-key' });
    const packs = happyPacks();
    await registerCardInvoke(INPUT, { container: buildContainer(packs) });
    expect(bakeSlabImage).toHaveBeenCalledWith(expect.anything(), {
      handle: 'test-card',
      image: '/images/test-card.webp',
    });
    expect(packs.createCards).toHaveBeenCalledWith([
      expect.objectContaining({
        slab_image: '/static/slab-x.webp',
        slab_image_key: 'slab-x-key',
      }),
    ]);
    // The product-metadata mirror is PUBLICLY readable: it must carry the
    // slab URL and must NEVER leak the private provider key.
    const run = jest.mocked(updateProductsWorkflow).mock.results.at(-1)!.value
      .run as jest.Mock;
    const { metadata } = run.mock.calls[0][0].input.products[0];
    expect(metadata).toMatchObject({ slab_image: '/static/slab-x.webp' });
    expect(metadata).not.toHaveProperty('slab_image_key');
  });

  it('blank grader skips the bake and stores nulls', async () => {
    const packs = happyPacks();
    await registerCardInvoke(
      { ...INPUT, grader: '  ' },
      { container: buildContainer(packs) },
    );
    expect(bakeSlabImage).not.toHaveBeenCalled();
    expect(packs.createCards).toHaveBeenCalledWith([
      expect.objectContaining({ slab_image: null, slab_image_key: null }),
    ]);
  });

  it('a failed bake still registers the card (nulls)', async () => {
    const packs = happyPacks();
    await registerCardInvoke(INPUT, { container: buildContainer(packs) });
    expect(packs.createCards).toHaveBeenCalledWith([
      expect.objectContaining({ slab_image: null, slab_image_key: null }),
    ]);
  });

  it('a failed metadata mirror undoes the card AND reclaims the composite', async () => {
    jest
      .mocked(bakeSlabImage)
      .mockResolvedValue({ url: '/static/slab-x.webp', key: 'slab-x-key' });
    jest.mocked(deleteSlabFile).mockClear();
    // The mirror write throws after the bake + insert succeeded.
    jest.mocked(updateProductsWorkflow).mockImplementationOnce(
      () =>
        ({
          run: jest.fn().mockRejectedValue(new Error('mirror down')),
        }) as never,
    );
    const packs = happyPacks();
    await expect(
      registerCardInvoke(INPUT, { container: buildContainer(packs) }),
    ).rejects.toThrow('mirror down');
    // Atomic undo: the Card row goes, and the just-uploaded composite —
    // referenced only by that row — is reclaimed instead of orphaned.
    expect(packs.deleteCards).toHaveBeenCalledWith(['card_1']);
    expect(deleteSlabFile).toHaveBeenCalledWith(
      expect.anything(),
      'slab-x-key',
    );
  });
});
