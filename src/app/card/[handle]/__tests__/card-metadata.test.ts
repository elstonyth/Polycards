// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const card = {
  handle: 'charizard-ex-105-psa-10-850072',
  name: 'Charizard EX #105',
  set: 'Pokemon Fire Red',
  grader: 'PSA',
  grade: '10',
};
let cardResult: { status: string; card?: typeof card };
vi.mock('next/navigation', () => ({ notFound: vi.fn() }));
vi.mock('@/lib/data/cards', () => ({
  getCardResult: async () => cardResult,
}));
vi.mock('../CardDetailHydrated', () => ({ CardDetailHydrated: () => null }));
vi.mock('../CardCloseButton', () => ({ CardCloseButton: () => null }));

const { default: CardPage, generateMetadata } = await import('../page');

const metadataFor = (handle: string) =>
  generateMetadata({ params: Promise.resolve({ handle }) });

describe('card page metadata', () => {
  it('describes the card itself, not the home page it used to inherit', async () => {
    cardResult = { status: 'ok', card };
    const meta = await metadataFor(card.handle);

    expect(meta.title).toBe(card.name);
    expect(meta.alternates?.canonical).toBe(`/card/${card.handle}`);
    expect(meta.openGraph).toMatchObject({
      title: card.name,
      description: 'Pokemon Fire Red · PSA 10',
      url: `/card/${card.handle}`,
      siteName: 'Polycards',
      images: [
        {
          url: `/card/${card.handle}/share.jpg`,
          width: 1080,
          height: 1080,
          type: 'image/jpeg',
          alt: card.name,
        },
      ],
    });
  });

  it('leaves the grade out of a raw card description', async () => {
    cardResult = { status: 'ok', card: { ...card, grader: '', grade: '' } };
    const meta = await metadataFor(card.handle);
    expect(meta.description).toBe('Pokemon Fire Red');
  });

  it('stays minimal for a card it cannot load', async () => {
    cardResult = { status: 'notfound' };
    expect(await metadataFor('nope-1')).toEqual({ title: 'Card not found' });
  });
});

describe('card page Product JSON-LD', () => {
  const render = async (name: string) => {
    cardResult = { status: 'ok', card: { ...card, name } };
    const page = await CardPage({
      params: Promise.resolve({ handle: card.handle }),
      searchParams: Promise.resolve({}),
    });
    return renderToStaticMarkup(page as ReactElement);
  };

  it('names the square share image as the product image', async () => {
    const html = await render(card.name);
    const json = html.match(
      /<script type="application\/ld\+json">(.*?)<\/script>/,
    )?.[1];
    const data = JSON.parse(json ?? '{}');

    expect(data['@type']).toBe('Product');
    expect(data.name).toBe(card.name);
    expect(data.sku).toBe(card.handle);
    expect(data.image).toMatch(new RegExp(`/card/${card.handle}/share\\.jpg$`));
    expect(data.image).toMatch(/^https?:\/\//);
  });

  it('cannot be broken out of by a card name', async () => {
    const html = await render('</script><img src=x onerror=alert(1)>');
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script>');
  });
});
