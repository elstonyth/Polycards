// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  createElement,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ResolvedPack } from '@/lib/packs-data';
import type { PackDetail } from '@/lib/data/packs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('next/link', () => ({
  default: ({
    children,
    scroll: _scroll,
    prefetch: _prefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    scroll?: boolean;
    prefetch?: boolean;
  }) => createElement('a', props, children),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) =>
    createElement('img', { src, alt }),
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: null }),
}));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({ balance: null, openTopUp: vi.fn() }),
}));
vi.mock('@/lib/use-pack-detail-poll', () => ({
  usePackDetailPoll: (_slug: string, initial: PackDetail | null) => initial,
}));
vi.mock('@/components/Reveal', () => ({
  default: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
}));
vi.mock('@/components/PullHistory', () => ({ PullHistory: () => null }));
vi.mock('@/components/cards/CardDetailOverlay', () => ({
  CardDetailOverlay: () => null,
}));

const { default: PackDetailClient } = await import('../PackDetailClient');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ah: ResolvedPack = {
  id: 'ah',
  name: 'Ascended Heroes',
  priceMyr: 60,
  image: '/ah.png',
  categoryId: 'pokemon',
  categoryName: 'Pokemon',
  icon: '/pokemon.png',
  group: 'RAW',
};
const bronze: ResolvedPack = {
  ...ah,
  id: 'bronze-pack',
  name: 'Bronze Pack',
  priceMyr: 300,
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.replaceState(null, '', '/slots/ah?count=2&source=qa#odds');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(pack: ResolvedPack) {
  await act(async () =>
    root.render(
      createElement(PackDetailClient, {
        pack,
        siblings: [ah, bronze],
        detail: null,
        recentPulls: { pulls: [], drought: {} },
        initialQty: 2,
      }),
    ),
  );
}

describe('pack sidebar navigation', () => {
  it('restores URL quantity when cached route props still carry an older count', async () => {
    window.history.replaceState(null, '', '/slots/ah?count=3');
    // The cached server snapshot still supplies initialQty=2.
    await render(ah);
    expect(
      container.querySelector('[aria-current="page"]')?.getAttribute('href'),
    ).toBe('/slots/ah?count=3');
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Increase quantity"]',
      )?.disabled,
    ).toBe(true);
  });

  it('keeps the current URL quantity in sync without adding Back entries', async () => {
    await render(ah);
    const historyLength = window.history.length;
    const increase = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Increase quantity"]',
    );
    const decrease = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Decrease quantity"]',
    );
    act(() => increase?.click());
    // Next's search-parameter subscription rerenders after replaceState.
    // This test's router boundary reads the current URL on each render.
    await render(ah);
    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe('/slots/ah?count=3&source=qa#odds');
    act(() => decrease?.click());
    await render(ah);
    act(() => decrease?.click());
    await render(ah);
    expect(new URL(window.location.href).searchParams.get('count')).toBe('1');
    expect(window.history.length).toBe(historyLength);
  });

  it('offers shareable pack URLs carrying the selected quantity', async () => {
    await render(ah);
    const rail = container.querySelector('[data-testid="pack-rail"]');
    const link = rail?.querySelector<HTMLAnchorElement>(
      'a[href="/slots/bronze-pack?count=2"]',
    );
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Bronze');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Increase quantity"]',
        )
        ?.click(),
    );
    await render(ah);
    expect(
      rail?.querySelector('a[href="/slots/bronze-pack?count=3"]'),
    ).not.toBeNull();
  });

  it('updates the heading and selected tile when route data changes in either direction', async () => {
    await render(ah);
    expect(container.querySelector('h1')?.textContent).toBe('Ascended Heroes');
    await render(bronze);
    expect(container.querySelector('h1')?.textContent).toBe('Bronze Pack');
    expect(
      container.querySelector('[aria-current="page"]')?.textContent,
    ).toContain('Bronze');
    await render(ah);
    expect(container.querySelector('h1')?.textContent).toBe('Ascended Heroes');
    expect(
      container.querySelector('[aria-current="page"]')?.textContent,
    ).toContain('Ascended Heroes');
  });
});
