import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

// The server render: auth has not hydrated yet, so the free-pack row can only
// show the server's visitor-agnostic answer.
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: null, isLoading: true }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const { default: HeroBoard } = await import('../HeroBoard');

it('keeps Polycards card backs without inventing hits when the catalog is unavailable', () => {
  const html = renderToStaticMarkup(createElement(HeroBoard, { hits: [], freePackPromo: false }));
  expect(html).toContain('Open packs.');
  expect(html).toContain('Pull real cards.');
  expect(html).toContain(
    encodeURIComponent('/images/app/polycards-slab-back.webp'),
  );
  expect(html).toContain('href="/slots"');
  expect(html).not.toMatch(
    /data-hero-hit|\bRM\s|gold-pack.webp|diamond-pack.webp|\/home\/hero\/|Next card|card rotation/i,
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
  const html = renderToStaticMarkup(createElement(HeroBoard, { hits, freePackPromo: false }));
  expect(html.match(/data-hero-hit=/g)).toHaveLength(3);
  for (const hit of hits) expect(html).toContain(hit.card.name);
  expect(html).toContain('1,234.56');
  expect(html).toContain('Gold Pack');
  expect(html).toContain('Pulls vary');
  expect(html).toContain('Next card');
  expect(html).toContain('Pause card rotation');
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  expect(html).toContain('aria-live="off"');
  expect(html).not.toContain('polycards-slab-back.webp');
});

it('puts the free welcome pack in the first paint only while one is on offer', () => {
  const on = renderToStaticMarkup(
    createElement(HeroBoard, { hits: [], freePackPromo: true }),
  );
  expect(on).toContain('data-testid="hero-free-pack"');
  expect(on).toContain('Your first pack is free');
  const off = renderToStaticMarkup(
    createElement(HeroBoard, { hits: [], freePackPromo: false }),
  );
  expect(off).not.toContain('hero-free-pack');
});
