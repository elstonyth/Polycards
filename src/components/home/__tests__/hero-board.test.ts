import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import HeroBoard from '../HeroBoard';

it('keeps Polycards card backs without inventing hits when the catalog is unavailable', () => {
  const html = renderToStaticMarkup(createElement(HeroBoard, { hits: [] }));
  expect(html).toContain('Open packs.');
  expect(html).toContain('Pull real cards.');
  expect(html).toContain(
    encodeURIComponent('/images/app/polycards-slab-back.webp'),
  );
  expect(html).toContain('href="/slots"');
  expect(html).not.toMatch(
    /data-hero-hit|\bRM\s|gold-pack.webp|diamond-pack.webp|\/home\/hero\//i,
  );
});

it('renders all three supplied slabs with the highest-value hit in front', () => {
  const hits = [1234.56, 987.65, 876.54].map((priceMyr, index) => ({
    pack: { id: 'gold', name: 'Gold Pack', priceMyr: 25, image: '/pack.webp' },
    card: {
      handle: `hit-${index}`,
      name: `Collectible ${index + 1}`,
      image: '/card.webp',
      slabImage: `/slab-${index}.webp`,
      rarity: 'Immortal' as const,
      priceMyr,
      pokemonDex: null,
      spriteImage: null,
    },
  }));
  const html = renderToStaticMarkup(createElement(HeroBoard, { hits }));
  expect(html.match(/data-hero-hit=/g)).toHaveLength(3);
  for (const hit of hits) expect(html).toContain(hit.card.name);
  expect(html).toContain('1,234.56');
  expect(html).toContain('Gold Pack');
  expect(html).toContain('Pulls vary');
  expect(html).not.toContain('polycards-slab-back.webp');
});
