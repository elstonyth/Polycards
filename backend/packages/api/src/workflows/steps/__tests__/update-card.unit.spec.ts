import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';

jest.mock('../../../api/admin/media/bake-slab', () => ({
  bakeSlabImage: jest.fn().mockResolvedValue(null),
  deleteSlabFile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@medusajs/medusa/core-flows', () => ({
  updateProductsWorkflow: jest.fn(() => ({
    run: jest.fn().mockResolvedValue({}),
  })),
  createProductsWorkflow: jest.fn(() => ({
    run: jest.fn().mockResolvedValue({ result: [{ id: 'prod_new' }] }),
  })),
}));
// Stub ONLY the store-context resolver (it pulls seller/channel/etc. modules
// the container stub doesn't carry); buildCardProductInput stays REAL — the
// upsert test below exists to prove it carries slab_image through.
jest.mock('../../../modules/packs/card-product', () => ({
  ...jest.requireActual('../../../modules/packs/card-product'),
  resolveCardProductContext: jest.fn().mockResolvedValue({
    sellerId: 'sel_1',
    shippingProfileId: 'sp_1',
    salesChannelId: 'sc_1',
    stockLocationId: 'sl_1',
  }),
}));
import {
  bakeSlabImage,
  deleteSlabFile,
} from '../../../api/admin/media/bake-slab';
import {
  createProductsWorkflow,
  updateProductsWorkflow,
} from '@medusajs/medusa/core-flows';
import { updateCardInvoke } from '../update-card';

const CARD = {
  id: 'card_1',
  handle: 'test-card',
  name: 'Test Card',
  set: 'Base',
  grader: 'PSA',
  grade: '9',
  market_value: 25,
  image: '/images/old.webp',
  price: null,
  for_sale: true,
  pokemon_dex: null,
  sprite_image: null,
  pc_product_id: null,
  pc_grade: null,
  market_multiplier: 1.2,
  slab_image: '/static/slab-old.webp',
  slab_image_key: 'old-key',
};

const PRODUCT = {
  id: 'prod_1',
  handle: 'test-card',
  title: 'Test Card',
  status: 'published',
  thumbnail: '/images/old.webp',
  images: [],
  metadata: {},
  variants: [{ id: 'var_1' }],
};

const INPUT = {
  handle: 'test-card',
  name: 'Test Card',
  set: 'Base',
  grader: 'PSA',
  grade: '9',
  market_value: 25,
  image: '/images/new.webp',
  for_sale: true,
  pokemon_dex: null as number | null,
  sprite_image: null as string | null,
};

const buildContainer = (
  packs: Record<string, jest.Mock>,
  products: unknown[] = [PRODUCT],
) => {
  const modules: Record<string, unknown> = {
    [PACKS_MODULE]: packs,
    [Modules.PRODUCT]: {
      listProducts: jest.fn().mockResolvedValue(products),
    },
    [ContainerRegistrationKeys.LOGGER]: { warn: jest.fn(), info: jest.fn() },
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

const packsStub = () => ({
  listCards: jest.fn().mockResolvedValue([CARD]),
  updateCards: jest.fn().mockResolvedValue([]),
  // resolveFxRate reads this for the NULL-price "use FMV" fallback (the MYR
  // mirror recomputes FMV × fx × multiplier). A firm 4.5 keeps the golden
  // vectors below deterministic. NOTE: pricing.ts caches the display rate
  // process-wide for 30s, so every stub in this file must agree on 4.5.
  listFxRates: jest
    .fn()
    .mockResolvedValue([
      { pair: 'USD_MYR', rate: 4.5, manual_override: false },
    ]),
});

describe('updateCardInvoke slab bake', () => {
  beforeEach(() => {
    jest.mocked(bakeSlabImage).mockReset().mockResolvedValue(null);
    jest.mocked(deleteSlabFile).mockReset().mockResolvedValue(undefined);
  });

  it('graded save re-bakes and stores the new url/key, deleting the old file', async () => {
    jest
      .mocked(bakeSlabImage)
      .mockResolvedValue({ url: '/static/slab-new.webp', key: 'new-key' });
    const packs = packsStub();
    await updateCardInvoke(INPUT, { container: buildContainer(packs) });
    expect(bakeSlabImage).toHaveBeenCalledWith(expect.anything(), {
      handle: 'test-card',
      image: '/images/new.webp',
      grader: 'PSA',
      grade: '9',
      name: 'Test Card',
      set: 'Base',
      label_year: null,
      label_note: null,
    });
    expect(packs.updateCards).toHaveBeenCalledWith([
      expect.objectContaining({
        slab_image: '/static/slab-new.webp',
        slab_image_key: 'new-key',
      }),
    ]);
    expect(deleteSlabFile).toHaveBeenCalledWith(expect.anything(), 'old-key');
    // The product-metadata mirror is PUBLICLY readable: it must carry the
    // slab URL and must NEVER leak the private provider key.
    const run = jest.mocked(updateProductsWorkflow).mock.results.at(-1)!.value
      .run as jest.Mock;
    const { metadata } = run.mock.calls[0][0].input.products[0];
    expect(metadata).toMatchObject({ slab_image: '/static/slab-new.webp' });
    expect(metadata).not.toHaveProperty('slab_image_key');
  });

  it('unchanged content hash (same key) skips the delete', async () => {
    jest
      .mocked(bakeSlabImage)
      .mockResolvedValue({ url: '/static/slab-old.webp', key: 'old-key' });
    const packs = packsStub();
    await updateCardInvoke(INPUT, { container: buildContainer(packs) });
    expect(deleteSlabFile).not.toHaveBeenCalled();
  });

  it('emptied grader still calls bakeSlabImage (gate lives inside it), clears both fields, deletes the old file', async () => {
    // §9: the caller no longer pre-checks the grader — bakeSlabImage's own
    // PSA gate returns null for a blank/non-PSA grader.
    const packs = packsStub();
    await updateCardInvoke(
      { ...INPUT, grader: '' },
      { container: buildContainer(packs) },
    );
    expect(bakeSlabImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grader: '' }),
    );
    expect(packs.updateCards).toHaveBeenCalledWith([
      expect.objectContaining({ slab_image: null, slab_image_key: null }),
    ]);
    expect(deleteSlabFile).toHaveBeenCalledWith(expect.anything(), 'old-key');
  });

  it('a failed bake nulls the fields and deletes the stale composite', async () => {
    const packs = packsStub();
    await updateCardInvoke(INPUT, { container: buildContainer(packs) });
    expect(packs.updateCards).toHaveBeenCalledWith([
      expect.objectContaining({ slab_image: null, slab_image_key: null }),
    ]);
    expect(deleteSlabFile).toHaveBeenCalledWith(expect.anything(), 'old-key');
  });

  it('defensive upsert (missing product) mirrors slab_image into the recreated product, never the key', async () => {
    jest
      .mocked(bakeSlabImage)
      .mockResolvedValue({ url: '/static/slab-new.webp', key: 'new-key' });
    const packs = packsStub();
    // No product for the handle → the upsert branch recreates it via the
    // REAL buildCardProductInput; its metadata must carry the baked URL.
    await updateCardInvoke(INPUT, { container: buildContainer(packs, []) });
    const run = jest.mocked(createProductsWorkflow).mock.results.at(-1)!.value
      .run as jest.Mock;
    const { metadata } = run.mock.calls[0][0].input.products[0];
    expect(metadata).toMatchObject({ slab_image: '/static/slab-new.webp' });
    expect(metadata).not.toHaveProperty('slab_image_key');
    expect(deleteSlabFile).toHaveBeenCalledWith(expect.anything(), 'old-key');
  });
});

describe('updateCardInvoke variant price mirror', () => {
  beforeEach(() => {
    jest.mocked(bakeSlabImage).mockReset().mockResolvedValue(null);
    jest.mocked(deleteSlabFile).mockReset().mockResolvedValue(undefined);
  });

  // Regression (2026-08-08 review of PR #397): this mirror used to write
  // `currency_code: 'usd', amount: price ?? market_value` — which both mixed
  // units (Card.price is MYR, market_value is USD) and, because
  // updatePriceSets REPLACES the whole set, deleted the variant's myr price
  // on every card edit. The store's single region sells in MYR.
  it('NULL card price mirrors the FMV-derived MYR display price, never a USD amount', async () => {
    const packs = packsStub();
    await updateCardInvoke(INPUT, { container: buildContainer(packs) });
    const run = jest.mocked(updateProductsWorkflow).mock.results.at(-1)!.value
      .run as jest.Mock;
    const variant = run.mock.calls[0][0].input.products[0].variants[0];
    // 25 USD × 4.5 × 1.2 (CARD carries no explicit input multiplier → the 1.2
    // default) = 135. The raw USD 25 must never appear as the amount.
    expect(variant.prices).toEqual([{ currency_code: 'myr', amount: 135 }]);
  });

  it('an explicit MYR price is mirrored verbatim under myr', async () => {
    const packs = packsStub();
    await updateCardInvoke(
      { ...INPUT, price: 99 },
      { container: buildContainer(packs) },
    );
    const run = jest.mocked(updateProductsWorkflow).mock.results.at(-1)!.value
      .run as jest.Mock;
    const variant = run.mock.calls[0][0].input.products[0].variants[0];
    expect(variant.prices).toEqual([{ currency_code: 'myr', amount: 99 }]);
  });
});

describe('updateCardInvoke rollback when the product mirror fails', () => {
  beforeEach(() => {
    jest.mocked(bakeSlabImage).mockReset().mockResolvedValue(null);
    jest.mocked(deleteSlabFile).mockReset().mockResolvedValue(undefined);
  });

  // Input that GENUINELY differs from CARD (25 / 'Test Card') so "restored the
  // old value" is distinguishable from "forward wrote the same value".
  const CHANGED = { ...INPUT, name: 'Changed Name', market_value: 999 };

  it('mirror throws → rethrows and restores the card to the snapshot values', async () => {
    jest.mocked(updateProductsWorkflow).mockReturnValueOnce({
      run: jest.fn().mockRejectedValue(new Error('mirror boom')),
    } as unknown as ReturnType<typeof updateProductsWorkflow>);
    const packs = packsStub();

    await expect(
      updateCardInvoke(CHANGED, { container: buildContainer(packs) }),
    ).rejects.toThrow('mirror boom');

    // Called twice: forward (999 / 'Changed Name'), then restore (25 / 'Test Card').
    expect(packs.updateCards).toHaveBeenCalledTimes(2);
    expect(packs.updateCards).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: 'card_1',
        name: 'Test Card',
        market_value: 25,
        slab_image_key: 'old-key',
      }),
    ]);
  });

  it('mirror throws → reclaims the new slab file, never the old one', async () => {
    jest
      .mocked(bakeSlabImage)
      .mockResolvedValue({ url: '/static/slab-new.webp', key: 'new-key' });
    jest.mocked(updateProductsWorkflow).mockReturnValueOnce({
      run: jest.fn().mockRejectedValue(new Error('mirror boom')),
    } as unknown as ReturnType<typeof updateProductsWorkflow>);
    const packs = packsStub();

    await expect(
      updateCardInvoke(CHANGED, { container: buildContainer(packs) }),
    ).rejects.toThrow('mirror boom');

    expect(deleteSlabFile).toHaveBeenCalledWith(expect.anything(), 'new-key');
    expect(deleteSlabFile).not.toHaveBeenCalledWith(
      expect.anything(),
      'old-key',
    );
  });

  it('mirror succeeds → no restore (updateCards once, only the old slab deleted)', async () => {
    jest
      .mocked(bakeSlabImage)
      .mockResolvedValue({ url: '/static/slab-new.webp', key: 'new-key' });
    const packs = packsStub();

    await updateCardInvoke(CHANGED, { container: buildContainer(packs) });

    expect(packs.updateCards).toHaveBeenCalledTimes(1);
    expect(deleteSlabFile).toHaveBeenCalledWith(expect.anything(), 'old-key');
    expect(deleteSlabFile).not.toHaveBeenCalledWith(
      expect.anything(),
      'new-key',
    );
  });

  it('upsert branch throws (no product) → rethrows and restores the card', async () => {
    jest.mocked(createProductsWorkflow).mockReturnValueOnce({
      run: jest.fn().mockRejectedValue(new Error('upsert boom')),
    } as unknown as ReturnType<typeof createProductsWorkflow>);
    const packs = packsStub();

    await expect(
      updateCardInvoke(CHANGED, { container: buildContainer(packs, []) }),
    ).rejects.toThrow('upsert boom');

    expect(packs.updateCards).toHaveBeenCalledTimes(2);
    expect(packs.updateCards).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: 'card_1',
        name: 'Test Card',
        market_value: 25,
      }),
    ]);
  });

  it('mirror throws on an unchanged re-bake → does NOT delete the reused key, still restores', async () => {
    // Content-hash filenames: an unchanged photo/label re-bake yields the SAME
    // key as the card already has. Reclaiming it would destroy the card's only
    // composite, then restore the card pointing at a deleted file.
    jest
      .mocked(bakeSlabImage)
      .mockResolvedValue({ url: 'u', key: CARD.slab_image_key });
    jest.mocked(updateProductsWorkflow).mockReturnValueOnce({
      run: jest.fn().mockRejectedValue(new Error('mirror boom')),
    } as unknown as ReturnType<typeof updateProductsWorkflow>);
    const packs = packsStub();

    await expect(
      updateCardInvoke(CHANGED, { container: buildContainer(packs) }),
    ).rejects.toThrow('mirror boom');

    expect(deleteSlabFile).not.toHaveBeenCalledWith(
      expect.anything(),
      CARD.slab_image_key,
    );
    // The card restore still ran (forward + restore = 2 calls).
    expect(packs.updateCards).toHaveBeenCalledTimes(2);
  });
});

describe('updateCardInvoke PC link / multiplier tri-state', () => {
  beforeEach(() => {
    jest.mocked(bakeSlabImage).mockReset().mockResolvedValue(null);
    jest.mocked(deleteSlabFile).mockReset().mockResolvedValue(undefined);
  });

  // A PriceCharting-linked card with a custom markup. The regression: a
  // name-only edit (no pc_* / multiplier in the body) used to write null /
  // 1.2, silently unlinking the card from the nightly price sync and resetting
  // its margin.
  const LINKED = {
    ...CARD,
    pc_product_id: 'pc_1',
    pc_grade: 'psa-10',
    market_multiplier: 1.5,
  };
  const linkedStub = () => ({
    ...packsStub(),
    listCards: jest.fn().mockResolvedValue([LINKED]),
  });
  const mirrorMetadata = () => {
    const run = jest.mocked(updateProductsWorkflow).mock.results.at(-1)!.value
      .run as jest.Mock;
    return run.mock.calls[0][0].input.products[0].metadata;
  };

  it('omitted pc_* and multiplier keep the stored link and markup (card AND product mirror)', async () => {
    const packs = linkedStub();
    await updateCardInvoke(INPUT, { container: buildContainer(packs) });
    expect(packs.updateCards).toHaveBeenCalledWith([
      expect.objectContaining({
        pc_product_id: 'pc_1',
        pc_grade: 'psa-10',
        market_multiplier: 1.5,
      }),
    ]);
    expect(mirrorMetadata()).toMatchObject({
      pc_product_id: 'pc_1',
      pc_grade: 'psa-10',
      market_multiplier: 1.5,
    });
  });

  it('omitted multiplier prices the NULL-price mirror at the STORED markup, not 1.2', async () => {
    const packs = linkedStub();
    await updateCardInvoke(INPUT, { container: buildContainer(packs) });
    const run = jest.mocked(updateProductsWorkflow).mock.results.at(-1)!.value
      .run as jest.Mock;
    const variant = run.mock.calls[0][0].input.products[0].variants[0];
    // 25 USD × 4.5 × 1.5 = 168.75 (1.2 would give 135).
    expect(variant.prices).toEqual([{ currency_code: 'myr', amount: 168.75 }]);
  });

  it('explicit null unlinks both pc fields and leaves the markup alone', async () => {
    const packs = linkedStub();
    await updateCardInvoke(
      { ...INPUT, pc_product_id: null, pc_grade: null },
      { container: buildContainer(packs) },
    );
    expect(packs.updateCards).toHaveBeenCalledWith([
      expect.objectContaining({
        pc_product_id: null,
        pc_grade: null,
        market_multiplier: 1.5,
      }),
    ]);
    expect(mirrorMetadata()).toMatchObject({
      pc_product_id: null,
      pc_grade: null,
      market_multiplier: 1.5,
    });
  });

  it('explicit multiplier sets it', async () => {
    const packs = linkedStub();
    await updateCardInvoke(
      { ...INPUT, market_multiplier: 1.3 },
      { container: buildContainer(packs) },
    );
    expect(packs.updateCards).toHaveBeenCalledWith([
      expect.objectContaining({
        pc_product_id: 'pc_1',
        pc_grade: 'psa-10',
        market_multiplier: 1.3,
      }),
    ]);
  });

  it('a card with no stored multiplier still defaults to 1.2 when omitted', async () => {
    const packs = {
      ...packsStub(),
      listCards: jest
        .fn()
        .mockResolvedValue([{ ...CARD, market_multiplier: null }]),
    };
    await updateCardInvoke(INPUT, { container: buildContainer(packs) });
    expect(packs.updateCards).toHaveBeenCalledWith([
      expect.objectContaining({ market_multiplier: 1.2 }),
    ]);
  });

  it('mirror throws after an unlink → the restore puts the link and markup back', async () => {
    jest.mocked(updateProductsWorkflow).mockReturnValueOnce({
      run: jest.fn().mockRejectedValue(new Error('mirror boom')),
    } as unknown as ReturnType<typeof updateProductsWorkflow>);
    const packs = linkedStub();
    await expect(
      updateCardInvoke(
        { ...INPUT, pc_product_id: null, pc_grade: null, market_multiplier: 2 },
        { container: buildContainer(packs) },
      ),
    ).rejects.toThrow('mirror boom');
    expect(packs.updateCards).toHaveBeenLastCalledWith([
      expect.objectContaining({
        pc_product_id: 'pc_1',
        pc_grade: 'psa-10',
        market_multiplier: 1.5,
      }),
    ]);
  });
});
