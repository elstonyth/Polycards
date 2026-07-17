import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import sharp from 'sharp';
import { PACKS_MODULE } from '../../../../modules/packs';

// rebakeAllGradedCards drives the frame-swap trigger and the backfill
// script. This spec runs the REAL function (composeSlab/bakeSlabImage
// execute for real, via sharp) against a stubbed container; only the Medusa
// I/O boundary (core-flows workflows) is mocked. Separate from
// bake-slab.unit.spec.ts, which exercises composeSlab directly with real
// sharp and must NOT get a core-flows mock.
//
// Covers: the product-metadata mirror added for the "rebake/repull/delete
// leaves a stale mirror" finding, and the once-per-loop frame resolve added
// for the "mid-loop frame-fetch failure silently rebakes with the bundled
// default" finding.
jest.mock('@medusajs/medusa/core-flows', () => ({
  uploadFilesWorkflow: jest.fn(() => ({
    run: jest.fn().mockResolvedValue({
      result: [{ url: 'https://cdn.example/slab.webp', id: 'file_slab' }],
    }),
  })),
  deleteFilesWorkflow: jest.fn(() => ({ run: jest.fn().mockResolvedValue({}) })),
  updateProductsWorkflow: jest.fn(() => ({ run: jest.fn().mockResolvedValue({}) })),
}));

import {
  uploadFilesWorkflow,
  updateProductsWorkflow,
  deleteFilesWorkflow,
} from '@medusajs/medusa/core-flows';
import { rebakeAllGradedCards } from '../bake-slab';

type CardRow = {
  id: string;
  handle: string;
  grader: string;
  grade: string;
  name: string;
  set: string;
  image: string;
  slab_image: string | null;
  slab_image_key: string | null;
  label_year?: string | null;
  label_note?: string | null;
};

let TEST_PHOTO: Buffer;
let originalFetch: typeof global.fetch;

beforeAll(async () => {
  TEST_PHOTO = await sharp({
    create: {
      width: 12,
      height: 16,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .png()
    .toBuffer();
  originalFetch = global.fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  jest.mocked(uploadFilesWorkflow).mockClear();
  jest.mocked(updateProductsWorkflow).mockClear();
  jest.mocked(deleteFilesWorkflow).mockClear();
  // Every fixture below has slab_frame_url: null, so resolveFrameBytes
  // returns the bundled default WITHOUT calling fetch — this mock only ever
  // serves the per-card photo fetch.
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: async () => TEST_PHOTO,
  }) as unknown as typeof fetch;
});

const buildContainer = (opts: {
  cards: CardRow[];
  products?: Array<{ id: string; handle: string; metadata: Record<string, unknown> }>;
  updateCards?: jest.Mock;
  siteSettings?: jest.Mock;
}) => {
  const products = opts.products ?? [];
  const listProducts = jest.fn(async (filter: { handle?: string } = {}) =>
    products.filter((p) => !filter.handle || p.handle === filter.handle),
  );
  const packs = {
    listCards: jest.fn().mockResolvedValue(opts.cards),
    updateCards: opts.updateCards ?? jest.fn().mockResolvedValue([]),
    siteSettings:
      opts.siteSettings ?? jest.fn().mockResolvedValue({ slab_frame_url: null }),
  };
  const modules: Record<string, unknown> = {
    [PACKS_MODULE]: packs,
    [Modules.PRODUCT]: { listProducts },
    [ContainerRegistrationKeys.LOGGER]: { warn: jest.fn(), info: jest.fn() },
  };
  const container = {
    resolve: (key: string) => {
      if (!(key in modules)) {
        throw new Error(`unit stub: unexpected container.resolve("${key}")`);
      }
      return modules[key];
    },
  } as unknown as MedusaContainer;
  return { container, packs, listProducts };
};

const uploadContentOf = (callIndex: number): string => {
  const value = jest.mocked(uploadFilesWorkflow).mock.results[callIndex]!.value as {
    run: jest.Mock;
  };
  return value.run.mock.calls[0][0].input.files[0].content;
};

describe('rebakeAllGradedCards', () => {
  const cardA: CardRow = {
    id: 'card_a',
    handle: 'card-a',
    grader: 'PSA',
    grade: '10',
    name: 'Pikachu ex #238',
    set: 'Pokemon Surging Sparks',
    image: 'https://img.example/a.png',
    slab_image: null,
    slab_image_key: 'old-a',
  };
  // §9: CGC never bakes — the PSA-branded frame can't lie about another
  // grader's slab. Used to exercise the rebake loop's "clear a stale
  // composite" branch (a leftover from the old frame-everything-as-PSA
  // behaviour).
  const cardB: CardRow = {
    id: 'card_b',
    handle: 'card-b',
    grader: 'CGC',
    grade: '9.5',
    name: 'Charizard ex #223',
    set: 'Pokemon Obsidian Flames',
    image: 'https://img.example/a.png', // same bytes as A on purpose (see below)
    slab_image: 'https://cdn.example/stale-b.webp',
    slab_image_key: 'old-b',
  };
  const ungraded: CardRow = {
    id: 'card_c',
    handle: 'card-c',
    grader: '',
    grade: '',
    name: 'Bulbasaur #001',
    set: 'Pokemon Base Set',
    image: 'https://img.example/c.png',
    slab_image: null,
    slab_image_key: null,
  };

  it('mirrors the new slab_image into product.metadata, merging (never the key)', async () => {
    const { container } = buildContainer({
      cards: [cardA],
      products: [{ id: 'prod_a', handle: 'card-a', metadata: { foo: 'bar' } }],
    });

    const result = await rebakeAllGradedCards(container);

    expect(result).toEqual({ ok: 1, failed: 0 });
    const run = jest.mocked(updateProductsWorkflow).mock.results.at(-1)!.value
      .run as jest.Mock;
    const { metadata } = run.mock.calls[0][0].input.products[0];
    expect(metadata).toMatchObject({
      foo: 'bar',
      slab_image: 'https://cdn.example/slab.webp',
    });
    expect(metadata).not.toHaveProperty('slab_image_key');
  });

  it('no product for the handle → mirror is a no-op, no throw', async () => {
    const { container } = buildContainer({ cards: [cardA], products: [] });

    await expect(rebakeAllGradedCards(container)).resolves.toEqual({
      ok: 1,
      failed: 0,
    });
    expect(updateProductsWorkflow).not.toHaveBeenCalled();
  });

  it('resolves the frame ONCE for N PSA cards, and bakes them all with it', async () => {
    // §9: only PSA cards reach bakeSlabImage — cardB (CGC) would take the
    // "clear stale composite" branch instead, so this test uses a SECOND PSA
    // card with the SAME image + label fields as cardA (byte-identical
    // composite) to exercise the multi-bake path.
    const cardA2: CardRow = { ...cardA, id: 'card_a2', handle: 'card-a2' };
    const siteSettings = jest.fn().mockResolvedValue({ slab_frame_url: null });
    const { container } = buildContainer({
      cards: [cardA, cardA2, ungraded],
      siteSettings,
    });

    const result = await rebakeAllGradedCards(container);

    expect(result).toEqual({ ok: 2, failed: 0 });
    expect(siteSettings).toHaveBeenCalledTimes(1);
    // Same photo bytes + a single resolved frame ⇒ byte-identical composite:
    // proves both graded cards baked against the SAME frameBytes.
    expect(uploadContentOf(0)).toBe(uploadContentOf(1));
  });

  it('clears a stale composite on a non-PSA graded card instead of baking it (§9)', async () => {
    const { container } = buildContainer({
      cards: [cardB],
      products: [
        { id: 'prod_b', handle: 'card-b', metadata: { slab_image: cardB.slab_image } },
      ],
    });

    const result = await rebakeAllGradedCards(container);

    expect(result).toEqual({ ok: 1, failed: 0 });
    expect(uploadFilesWorkflow).not.toHaveBeenCalled(); // never baked
    const run = jest.mocked(updateProductsWorkflow).mock.results.at(-1)!.value
      .run as jest.Mock;
    expect(run.mock.calls[0][0].input.products[0].metadata).toMatchObject({
      slab_image: null,
    });
    const deletedIds = jest
      .mocked(deleteFilesWorkflow)
      .mock.results.flatMap(
        (r) =>
          (r.value as { run: jest.Mock }).run.mock.calls[0][0].input
            .ids as string[],
      );
    expect(deletedIds).toContain('old-b');
  });

  it('a per-card persist failure is isolated: failed++ and the loop continues', async () => {
    const updateCards = jest.fn(async (rows: Array<{ id: string }>) => {
      if (rows[0]!.id === cardA.id) throw new Error('db down');
      return rows;
    });
    const { container } = buildContainer({
      cards: [cardA, cardB],
      products: [{ id: 'prod_b', handle: 'card-b', metadata: {} }],
      updateCards,
    });

    const result = await rebakeAllGradedCards(container);

    expect(result).toEqual({ ok: 1, failed: 1 });
    // card-a's persist threw before the mirror step (never mirrored); card-b's
    // persist succeeded and the loop kept going (mirrored once).
    expect(updateProductsWorkflow).toHaveBeenCalledTimes(1);
    // Storage stays consistent on both paths: card-a's just-uploaded
    // composite (unreferenced after the failed write) is reclaimed, and
    // card-b's superseded old composite is deleted as usual.
    const deletedIds = jest
      .mocked(deleteFilesWorkflow)
      .mock.results.flatMap(
        (r) =>
          (r.value as { run: jest.Mock }).run.mock.calls[0][0].input
            .ids as string[],
      );
    expect(deletedIds).toContain('file_slab'); // card-a orphan cleanup
    expect(deletedIds).toContain('old-b'); // card-b old composite
  });
});
