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
import {
  bakeSlabImage,
  deleteSlabFile,
} from '../../../api/admin/media/bake-slab';
import { updateProductsWorkflow } from '@medusajs/medusa/core-flows';
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

const buildContainer = (packs: Record<string, jest.Mock>) => {
  const modules: Record<string, unknown> = {
    [PACKS_MODULE]: packs,
    [Modules.PRODUCT]: {
      listProducts: jest.fn().mockResolvedValue([PRODUCT]),
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

  it('emptied grader clears both fields and deletes the old file', async () => {
    const packs = packsStub();
    await updateCardInvoke(
      { ...INPUT, grader: '' },
      { container: buildContainer(packs) },
    );
    expect(bakeSlabImage).not.toHaveBeenCalled();
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
});
