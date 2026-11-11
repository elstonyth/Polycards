import replaceCatalogPolycards, {
  CONFIRM_CATALOG_WIPE,
} from '../replace-catalog-polycards';

// Audit 2026-11-11 F5: with none of the 5 Polycards slugs live, the one-shot
// guard passed and a run hard-deleted every vault. It now needs the operator
// to name the wipe first.

const fakeContainer = () => {
  const packs = new Proxy({} as Record<string, jest.Mock>, {
    get: (target, key: string) => (target[key] ??= jest.fn().mockResolvedValue([])),
  });
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const container = {
    resolve: (key: string) =>
      key === 'packs' ? packs : key === 'logger' ? logger : {},
  };
  return { container, packs };
};

describe('replace-catalog-polycards confirm guard', () => {
  const original = process.env.CONFIRM_CATALOG_WIPE;
  afterEach(() => {
    if (original === undefined) delete process.env.CONFIRM_CATALOG_WIPE;
    else process.env.CONFIRM_CATALOG_WIPE = original;
  });

  it.each([undefined, '', 'yes', 'WIPE-ALL-PULLS'])(
    'refuses with CONFIRM_CATALOG_WIPE=%p before reading or deleting anything',
    async (value) => {
      if (value === undefined) delete process.env.CONFIRM_CATALOG_WIPE;
      else process.env.CONFIRM_CATALOG_WIPE = value;
      const { container, packs } = fakeContainer();
      await expect(
        replaceCatalogPolycards({ container } as never),
      ).rejects.toThrow(/CONFIRM_CATALOG_WIPE=wipe-all-pulls/);
      expect(Object.keys(packs)).toEqual([]);
    },
  );

  it('gets past the guard with the exact confirm value', async () => {
    process.env.CONFIRM_CATALOG_WIPE = CONFIRM_CATALOG_WIPE;
    const { container, packs } = fakeContainer();
    // An existing Polycards pack makes the one-shot guard stop the run right
    // after, so nothing below it runs in this test.
    packs.listPacks = jest.fn().mockResolvedValue([{ slug: 'bronze-pack' }]);
    await replaceCatalogPolycards({ container } as never);
    expect(packs.listPacks).toHaveBeenCalledTimes(1);
    // Nothing else on the service was even looked up, deletes included.
    expect(Object.keys(packs)).toEqual(['listPacks']);
  });
});
