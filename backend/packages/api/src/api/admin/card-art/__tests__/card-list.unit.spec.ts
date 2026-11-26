import {
  fetchCardList,
  parsePromoSubsets,
  parseSetPage,
  parseSetSlugs,
} from '../card-list';

const row = (href: string, code: string, name: string) => `
<tr data-hover="https://cdn/x.webp">
                    <td><a href="/cards/${href}">${code}</a></td>
                    <td><a href="/cards/${href}">${name}</a></td>
                    <td class="md-only">
                        <a href="/cards/${href}">
                            Character
                        </a>
                    </td>
</tr>`;

describe('parseSetSlugs', () => {
  it('finds every booster, starter, extra, premium set and the promos', () => {
    const html = `<a href="/cards/op01-romance-dawn">x</a><a href="/cards/st21-ex-gear-5">y</a>
      <a href="/cards/eb02-anime-25th-collection">z</a><a href="/cards/prb01-premium-booster-one-piece-the-best">p</a>
      <a href="/cards/promos">q</a><a href="/cards/advanced">no</a><a href="/cards/op01-romance-dawn">dup</a>`;
    expect(parseSetSlugs(html)).toEqual([
      'op01-romance-dawn',
      'st21-ex-gear-5',
      'eb02-anime-25th-collection',
      'prb01-premium-booster-one-piece-the-best',
      'promos',
    ]);
  });
});

describe('parseSetPage', () => {
  it('reads each printing: base code, alternate art as _pN, the name unescaped', () => {
    const html =
      row('OP01-001', 'OP01-001', 'Roronoa Zoro') +
      row('OP01-013?v=1', 'OP01-013', 'Sanji') +
      row('P-001?v=2', 'P-001', 'Monkey.D.Luffy') +
      row('OP01-016', 'OP01-016', 'Nami &amp; Robin');
    expect(parseSetPage(html)).toEqual([
      { code: 'OP01-001', name: 'Roronoa Zoro' },
      { code: 'OP01-013_p1', name: 'Sanji' },
      { code: 'P-001_p2', name: 'Monkey.D.Luffy' },
      { code: 'OP01-016', name: 'Nami & Robin' },
    ]);
  });

  it('decodes each entity once: an escaped "&lt;" stays "&lt;"', () => {
    expect(
      parseSetPage(row('OP01-017', 'OP01-017', 'A &amp;lt;B&amp;gt; &#039;C&#39;')),
    ).toEqual([{ code: 'OP01-017', name: "A &lt;B&gt; 'C'" }]);
  });
});

describe('fetchCardList', () => {
  it('reads the index and every set, one entry per printing even when a set reprints it', async () => {
    const pages: Record<string, string> = {
      '/cards':
        '<a href="/cards/op01-romance-dawn"></a><a href="/cards/prb01-premium-booster-one-piece-the-best"></a>',
      '/cards/op01-romance-dawn?display=list':
        row('OP01-001', 'OP01-001', 'Zoro') +
        row('OP01-002', 'OP01-002', 'Law'),
      '/cards/prb01-premium-booster-one-piece-the-best?display=list':
        row('OP01-001', 'OP01-001', 'Zoro') +
        row('OP01-001?v=3', 'OP01-001', 'Zoro'),
    };
    const got = await fetchCardList(async (path) => {
      if (!(path in pages)) throw new Error(`unexpected ${path}`);
      return pages[path];
    });
    expect(got.map((c) => c.code)).toEqual([
      'OP01-001',
      'OP01-002',
      'OP01-001_p3',
    ]);
  });
  it('a failing page fails the whole read (a partial list would report false gaps)', async () => {
    await expect(
      fetchCardList(async (path) => {
        if (path === '/cards') return '<a href="/cards/op01-romance-dawn"></a>';
        throw new Error('HTTP 503');
      }),
    ).rejects.toThrow('HTTP 503');
  });
});

describe('promo sub-sets', () => {
  it('lists the promo sub-set pages, never a main set or a card link', () => {
    const html = `<a href="/cards/prize-cards"></a><a href="/cards/misc-promos"></a>
      <a href="/cards/op01-romance-dawn"></a><a href="/cards/P-001"></a><a href="/cards/promos"></a>`;
    expect(parsePromoSubsets(html, ['op01-romance-dawn', 'promos'])).toEqual(['prize-cards', 'misc-promos']);
  });
  it('the read includes their printings', async () => {
    const pages: Record<string, string> = {
      '/cards': '<a href="/cards/op01-romance-dawn"></a><a href="/cards/promos"></a>',
      '/cards/promos': '<a href="/cards/prize-cards"></a>',
      '/cards/op01-romance-dawn?display=list': row('OP01-001', 'OP01-001', 'Zoro'),
      '/cards/promos?display=list': row('P-001', 'P-001', 'Luffy'),
      '/cards/prize-cards?display=list': row('OP01-001?v=5', 'OP01-001', 'Zoro'),
    };
    const got = await fetchCardList(async (path) => pages[path] ?? Promise.reject(new Error(path)));
    expect(got.map((c) => c.code).sort()).toEqual(['OP01-001', 'OP01-001_p5', 'P-001']);
  });
});
