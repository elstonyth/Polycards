import { pcSetToTcgName } from '../tcg-meta';

describe('pcSetToTcgName', () => {
  it('strips the Pokemon prefix', () => {
    expect(pcSetToTcgName('Pokemon Surging Sparks')).toBe('Surging Sparks');
  });
  it('routes Japanese sets to null — pokemontcg.io has zero JP coverage (§7a)', () => {
    expect(pcSetToTcgName('Pokemon Japanese Mega Dream ex')).toBeNull();
  });
  it('returns null for blank input', () => {
    expect(pcSetToTcgName('  ')).toBeNull();
  });
});

describe('fetchTcgCardMeta', () => {
  let fetchMock: jest.SpyInstance;
  // Module-level caches persist for the life of the module — isolate it fresh
  // per test (brief's documented alternative to distinct set names per test)
  // so one test's cached set/card never leaks into the next.
  let fetchTcgCardMeta: (typeof import('../tcg-meta.js'))['fetchTcgCardMeta'];
  beforeEach(async () => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    await jest.isolateModulesAsync(async () => {
      ({ fetchTcgCardMeta } = await import('../tcg-meta.js'));
    });
  });
  afterEach(() => fetchMock.mockRestore());

  const setResp = {
    data: [{ id: 'sv8', name: 'Surging Sparks', releaseDate: '2024/11/08' }],
  };
  const cardResp = { data: [{ rarity: 'Special Illustration Rare' }] };

  it('resolves year from the set and UPPERCASED rarity from the card', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(setResp), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cardResp), { status: 200 }),
      );
    expect(await fetchTcgCardMeta('Pokemon Surging Sparks', '#238')).toEqual({
      year: '2024',
      note: 'SPECIAL ILLUSTRATION RARE',
    });
  });

  it('degrades to nulls on any upstream failure (§7a — never blocks manual entry)', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await fetchTcgCardMeta('Pokemon Lost Origin Zzz', '#1')).toEqual({
      year: null,
      note: null,
    });
  });

  it('serves a repeat set lookup from cache', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(setResp), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cardResp), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cardResp), { status: 200 }),
      );
    await fetchTcgCardMeta('Pokemon Surging Sparks', '#238');
    await fetchTcgCardMeta('Pokemon Surging Sparks', '#239');
    // 3 calls total: set once (cached on the 2nd card), card twice
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('strips double-quotes from the set name before building the Lucene query', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await fetchTcgCardMeta('Pokemon Evil" OR name:x', '#1');
    const url = fetchMock.mock.calls[0][0] as string;
    // The quote can no longer close the phrase — the whole input stays inside it.
    expect(decodeURIComponent(url)).toContain('name:"Evil OR name:x"');
  });

  it('refuses a card number with query specials — year still prefills, no card lookup', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(setResp), { status: 200 }),
    );
    expect(
      await fetchTcgCardMeta('Pokemon Surging Sparks', '#238 OR set.id:base1'),
    ).toEqual({ year: '2024', note: null });
    expect(fetchMock).toHaveBeenCalledTimes(1); // set query only
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/sets?q=');
    expect(url).not.toContain('/cards?q=');
  });

  it('returns nulls for a Japanese set without any network call', async () => {
    expect(
      await fetchTcgCardMeta('Pokemon Japanese Mega Dream ex', '#240'),
    ).toEqual({
      year: null,
      note: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
