// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import { ProductJsonLd } from '@/lib/product-share';

// A pack's own address under the preview switch opens the home flow on that
// pack; without the switch the route renders the pack page exactly as before.

const data = {
  pack: { name: '151', categoryName: 'Pokemon', draft: false },
};
const loadPackPage = vi.fn(async () => data);
class Redirect extends Error {}
const redirect = vi.fn((to: string) => {
  throw new Redirect(to);
});
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect }));
const getPackBaseForViewer = vi.fn(async () => null);
vi.mock('@/lib/data/packs', () => ({ getPackBaseForViewer }));
vi.mock('@/lib/data/pack-page', () => ({ loadPackPage }));
vi.mock('../PackPage', () => ({
  default: ({ initialQty }: { initialQty: number }) =>
    createElement('main', null, `pack page ${initialQty}`),
}));

const { default: Page, generateMetadata } = await import('../page');
const PackPage = (await import('../PackPage')).default;

const render = async (search: Record<string, string | string[]>) =>
  renderToStaticMarkup(
    (await Page({
      params: Promise.resolve({ slug: '151' }),
      searchParams: Promise.resolve(search),
    })) as ReactElement,
  );

/** The pack page for /slots/151 as the route has always built it. */
const today = (qty: number) =>
  renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(ProductJsonLd, {
        name: '151',
        description: '151 · Pokemon',
        sku: '151',
        path: '/slots/151',
      }),
      createElement(PackPage, { initial: data as never, initialQty: qty }),
    ),
  ).replace(/^<div>|<\/div>$/g, '');

beforeEach(() => {
  vi.unstubAllEnvs();
  loadPackPage.mockClear();
  redirect.mockClear();
  getPackBaseForViewer.mockClear();
});
const metadata = (search: Record<string, string>) =>
  generateMetadata({
    params: Promise.resolve({ slug: '151' }),
    searchParams: Promise.resolve(search),
  });
afterEach(() => vi.unstubAllEnvs());

describe('a pack address with the preview switch off', () => {
  it('renders the pack page exactly as before, and never leaves it', async () => {
    vi.stubEnv('HOME_PREVIEW', '');
    expect(await render({})).toBe(today(1));
    expect(await render({ count: '2' })).toBe(today(2));
    expect(await render({ count: '9' })).toBe(today(3));
    expect(redirect).not.toHaveBeenCalled();
  });

  it('an empty or repeated count still renders the pack page for one, as before', async () => {
    vi.stubEnv('HOME_PREVIEW', '');
    expect(await render({ count: '' })).toBe(today(1));
    expect(await render({ count: ['2', '3'] })).toBe(today(1));
    expect(redirect).not.toHaveBeenCalled();
  });

  it('development alone keeps the pack page, title included', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HOME_PREVIEW', '');
    expect(await render({})).toBe(today(1));
    expect(redirect).not.toHaveBeenCalled();
    expect(await metadata({})).toEqual({ title: 'Pack' });
  });

  it('reads the pack for its title', async () => {
    vi.stubEnv('HOME_PREVIEW', '');
    expect(await metadata({})).toEqual({ title: 'Pack' });
    expect(getPackBaseForViewer).toHaveBeenCalledWith('151');
  });
});

describe('a pack address with the preview switch on', () => {
  beforeEach(() => {
    vi.stubEnv('HOME_PREVIEW', '1');
  });

  it('never writes a script into the page: a document load is redirected by the proxy, any load that reaches the page takes the redirect', async () => {
    await expect(render({ utm_source: 'ad' })).rejects.toThrow(
      '/home-preview?utm_source=ad&focus=151',
    );
    expect(loadPackPage).not.toHaveBeenCalled();
  });

  it('does not read the pack for a page that is never shown', async () => {
    expect(await metadata({})).toEqual({});
    expect(getPackBaseForViewer).not.toHaveBeenCalled();
  });

  it("titles the pack page's own links (?count=) as before", async () => {
    await metadata({ count: '1' });
    expect(getPackBaseForViewer).toHaveBeenCalledWith('151');
  });

  it('a move inside the site opens the flow on that pack (its other query kept)', async () => {
    await expect(render({})).rejects.toThrow('/home-preview?focus=151');
    await expect(render({ utm_source: 'ad' })).rejects.toThrow(
      '/home-preview?utm_source=ad&focus=151',
    );
    expect(loadPackPage).not.toHaveBeenCalled();
  });

  it("the pack page's own links (?count=) still open the pack page", async () => {
    expect(await render({ count: '1' })).toBe(today(1));
    expect(redirect).not.toHaveBeenCalled();
  });
});
