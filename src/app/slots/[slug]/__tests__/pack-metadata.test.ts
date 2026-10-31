// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const pack = {
  id: 'bronze-pack',
  name: 'Bronze Pack',
  categoryId: 'pokemon',
  categoryName: 'Pokemon',
  image: '/images/polycards/bronze-pack.webp',
};
let base: { pack: typeof pack; siblings: never[] } | null;
vi.mock('next/navigation', () => ({ notFound: vi.fn() }));
vi.mock('@/lib/data/packs', () => ({
  getPackBaseForViewer: async () => base,
  getDraftPackDetail: async () => null,
  getPackDetail: async () => null,
  getRecentPulls: async () => [],
}));
vi.mock('@/lib/data/free-pack', () => ({
  canClaimFreePack: () => false,
  freePackMissing: () => [],
  getFreePackState: async () => null,
}));
vi.mock('../PackDetailClient', () => ({ default: () => null }));

const { default: PackPage, generateMetadata } = await import('../page');

const metadataFor = (slug: string) =>
  generateMetadata({ params: Promise.resolve({ slug }) });

describe('pack page metadata', () => {
  it('describes the pack itself, not the home page', async () => {
    base = { pack, siblings: [] };
    const meta = await metadataFor(pack.id);

    expect(meta.title).toBe('Bronze Pack — Pokemon');
    expect(meta.openGraph).toMatchObject({
      title: 'Bronze Pack',
      description: 'Bronze Pack · Pokemon',
      url: '/slots/bronze-pack',
      siteName: 'Polycards',
      images: [
        {
          url: '/slots/bronze-pack/share.jpg',
          width: 1080,
          height: 1080,
          type: 'image/jpeg',
          alt: 'Bronze Pack',
        },
      ],
    });
  });

  it('stays minimal for a pack it cannot find', async () => {
    base = null;
    expect(await metadataFor('nope')).toEqual({ title: 'Pack' });
  });
});

describe('pack page Product JSON-LD', () => {
  const render = async (name: string) => {
    base = { pack: { ...pack, name }, siblings: [] };
    const page = await PackPage({
      params: Promise.resolve({ slug: pack.id }),
      searchParams: Promise.resolve({}),
    });
    return renderToStaticMarkup(page as ReactElement);
  };

  it('names the square share image as the product image', async () => {
    const html = await render(pack.name);
    const json = html.match(
      /<script type="application\/ld\+json">(.*?)<\/script>/,
    )?.[1];
    const data = JSON.parse(json ?? '{}');

    expect(data['@type']).toBe('Product');
    expect(data.name).toBe(pack.name);
    expect(data.sku).toBe(pack.id);
    expect(data.image).toMatch(
      /^https?:\/\/.*\/slots\/bronze-pack\/share\.jpg$/,
    );
    expect(data.offers).toBeUndefined();
  });

  it('cannot be broken out of by a pack name', async () => {
    const html = await render('</script><img src=x onerror=alert(1)>');
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script>');
  });
});
