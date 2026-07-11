import {
  displayMarketPrice,
  effectiveRate,
  resolveFxRate,
  resolveFxRateInfo,
  resolveFxRateStrict,
  DEFAULT_USD_MYR,
} from "../pricing";

test("raw×fx×mult rounded", () => {
  expect(displayMarketPrice(100, 4.7, 1.2)).toBe(564);
  expect(displayMarketPrice(19.99, 4.5, 1.2)).toBe(107.95);
});

test("invalid → 0", () => {
  expect(displayMarketPrice(-1, 4.7, 1.2)).toBe(0);
  expect(displayMarketPrice(100, 0, 1.2)).toBe(0);
  expect(displayMarketPrice(NaN, 4.7, 1.2)).toBe(0);
});

test("effectiveRate override/fallback", () => {
  expect(effectiveRate({ rate: 4.5, manual_override: true, manual_rate: 4.8 })).toBe(4.8);
  expect(effectiveRate({ rate: 4.5, manual_override: false, manual_rate: null })).toBe(4.5);
  expect(effectiveRate({ rate: 0, manual_override: false, manual_rate: null })).toBe(DEFAULT_USD_MYR);
  expect(effectiveRate(null)).toBe(DEFAULT_USD_MYR);
});

describe('resolveFxRateStrict — no silent fallback on money paths', () => {
  it('returns the manual override when set', async () => {
    const rate = await resolveFxRateStrict({
      listFxRates: async () => [
        { rate: 4.7, manual_override: true, manual_rate: 4.0 },
      ],
    });
    expect(rate).toBe(4.0);
  });

  it('returns the fetched rate otherwise', async () => {
    const rate = await resolveFxRateStrict({
      listFxRates: async () => [
        { rate: 4.55, manual_override: false, manual_rate: null },
      ],
    });
    expect(rate).toBe(4.55);
  });

  it('throws when no row exists (never the hardcoded default)', async () => {
    await expect(
      resolveFxRateStrict({ listFxRates: async () => [] }),
    ).rejects.toThrow(/exchange rate/i);
  });

  it('throws when the query fails', async () => {
    await expect(
      resolveFxRateStrict({
        listFxRates: async () => {
          throw new Error('db down');
        },
      }),
    ).rejects.toThrow(/exchange rate/i);
  });

  it('throws when the stored rate is unusable', async () => {
    await expect(
      resolveFxRateStrict({
        listFxRates: async () => [
          { rate: 0, manual_override: false, manual_rate: null },
        ],
      }),
    ).rejects.toThrow(/exchange rate/i);
  });
});

describe('resolveFxRateInfo — quotes must know whether FX is firm (sim finding P1-1)', () => {
  // The reveal stamps a "firm" instant-buyback quote; the credit path refuses
  // on fallback FX. The quote must therefore know when the rate came from a
  // real FxRate row (firm) vs the hardcoded default (not firm), so it is never
  // presented as a promise the sell will refuse.

  it('is firm on a real fetched rate', async () => {
    const info = await resolveFxRateInfo({
      listFxRates: async () => [
        { rate: 4.55, manual_override: false, manual_rate: null },
      ],
    });
    expect(info).toEqual({ rate: 4.55, firm: true });
  });

  it('is firm on a valid manual override', async () => {
    const info = await resolveFxRateInfo({
      listFxRates: async () => [
        { rate: 4.7, manual_override: true, manual_rate: 4.0 },
      ],
    });
    expect(info).toEqual({ rate: 4.0, firm: true });
  });

  it('falls through an invalid manual override to the fetched rate (firm)', async () => {
    const info = await resolveFxRateInfo({
      listFxRates: async () => [
        { rate: 4.55, manual_override: true, manual_rate: 0 },
      ],
    });
    expect(info).toEqual({ rate: 4.55, firm: true });
  });

  it('is NOT firm when no row exists (default rate, display-only)', async () => {
    const info = await resolveFxRateInfo({ listFxRates: async () => [] });
    expect(info).toEqual({ rate: DEFAULT_USD_MYR, firm: false });
  });

  it('is NOT firm when the query fails', async () => {
    const info = await resolveFxRateInfo({
      listFxRates: async () => {
        throw new Error('db down');
      },
    });
    expect(info).toEqual({ rate: DEFAULT_USD_MYR, firm: false });
  });

  it('is NOT firm when the stored rate is unusable', async () => {
    const info = await resolveFxRateInfo({
      listFxRates: async () => [
        { rate: 0, manual_override: false, manual_rate: null },
      ],
    });
    expect(info).toEqual({ rate: DEFAULT_USD_MYR, firm: false });
  });

  // Row fields are bigNumber-backed and can come back as strings — the
  // Number(...) normalization must treat a numeric string as a real rate.
  it('normalizes string row fields and stays firm (manual override wins)', async () => {
    const info = await resolveFxRateInfo({
      listFxRates: async () => [
        {
          rate: '4.55',
          manual_override: true,
          manual_rate: '4.2',
        } as unknown as { rate: number; manual_override: boolean; manual_rate: number },
      ],
    });
    expect(info).toEqual({ rate: 4.2, firm: true });
  });

  it('is NOT firm when the stored rate normalizes to NaN', async () => {
    const info = await resolveFxRateInfo({
      listFxRates: async () => [
        { rate: NaN, manual_override: false, manual_rate: null },
      ],
    });
    expect(info).toEqual({ rate: DEFAULT_USD_MYR, firm: false });
  });

  it('is NOT firm when the row field is a non-numeric string', async () => {
    const info = await resolveFxRateInfo({
      listFxRates: async () => [
        {
          rate: 'not-a-rate',
          manual_override: false,
          manual_rate: null,
        } as unknown as { rate: number; manual_override: boolean; manual_rate: null },
      ],
    });
    expect(info).toEqual({ rate: DEFAULT_USD_MYR, firm: false });
  });

  // The invariant that closes the finding: the quote is firm exactly when the
  // money path would pay. If these ever diverge, a shown quote can be refused.
  it('firm === strict-resolver-succeeds, and both agree on the rate', async () => {
    const fixtures = [
      [{ rate: 4.55, manual_override: false, manual_rate: null }],
      [{ rate: 4.7, manual_override: true, manual_rate: 4.0 }],
      [{ rate: 0, manual_override: false, manual_rate: null }],
      [],
      'throw',
    ] as const;
    for (const rows of fixtures) {
      const packs = {
        listFxRates: async () => {
          if (rows === 'throw') throw new Error('db down');
          return [...rows];
        },
      };
      const info = await resolveFxRateInfo(packs);
      const strict = await resolveFxRateStrict(packs).then(
        (rate) => ({ ok: true as const, rate }),
        () => ({ ok: false as const }),
      );
      expect(info.firm).toBe(strict.ok);
      if (strict.ok) expect(info.rate).toBe(strict.rate);
      // The lenient resolver is the same resolution's rate view.
      expect(await resolveFxRate(packs)).toBe(info.rate);
    }
  });
});
