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
let rsc: string | null = '1';
vi.mock('next/headers', () => ({
  headers: async () => new Headers(rsc === null ? {} : { rsc }),
}));
vi.mock('@/lib/data/packs', () => ({ getPackBaseForViewer: async () => null }));
vi.mock('@/lib/data/pack-page', () => ({ loadPackPage }));
vi.mock('../PackPage', () => ({
  default: ({ initialQty }: { initialQty: number }) =>
    createElement('main', null, `pack page ${initialQty}`),
}));

const { default: Page } = await import('../page');
const PackPage = (await import('../PackPage')).default;

const render = async (search: Record<string, string>) =>
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
});

describe('a pack address with the preview switch on', () => {
  beforeEach(() => {
    vi.stubEnv('HOME_PREVIEW', '1');
    rsc = '1';
  });

  it('a document load replaces itself with the flow page on that pack', async () => {
    rsc = null;
    expect(await render({ stage: '3d' })).toBe(
      '<script>location.replace("/home-preview?stage=3d&focus=151")</script>',
    );
    expect(loadPackPage).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a move inside the site opens the flow on that pack (its other query kept)', async () => {
    await expect(render({})).rejects.toThrow('/home-preview?focus=151');
    await expect(render({ stage: '3d' })).rejects.toThrow(
      '/home-preview?stage=3d&focus=151',
    );
    expect(loadPackPage).not.toHaveBeenCalled();
  });

  it("the pack page's own links (?count=) still open the pack page", async () => {
    expect(await render({ count: '1' })).toBe(today(1));
    expect(redirect).not.toHaveBeenCalled();
  });
});
