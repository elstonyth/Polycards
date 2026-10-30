// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  createElement,
  type AnchorHTMLAttributes,
  type ReactElement,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';

const back = vi.fn();
const replace = vi.fn();
let cardResult: { status: string; card?: { handle: string } };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back, replace }),
  notFound: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', props),
}));
vi.mock('@/lib/data/cards', () => ({
  getCardResult: async () => cardResult,
}));
vi.mock('../CardDetailHydrated', () => ({ CardDetailHydrated: () => null }));

const { CardCloseButton } = await import('../CardCloseButton');
const { default: CardPage } = await import('../page');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  back.mockClear();
  replace.mockClear();
  cardResult = { status: 'ok', card: { handle: 'mewtwo' } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('CardCloseButton', () => {
  function renderClose(historyLength: number) {
    vi.spyOn(History.prototype, 'length', 'get').mockReturnValue(historyLength);
    act(() => root.render(createElement(CardCloseButton)));
    const button = container.querySelector('button');
    expect(button?.textContent).toContain('Close');
    return button;
  }

  it('goes back to where the prize was tapped', () => {
    const button = renderClose(3);
    act(() => button?.click());
    expect(back).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it('swaps itself for the leaderboard when there is nothing to go back to', () => {
    const button = renderClose(1);
    act(() => button?.click());
    expect(replace).toHaveBeenCalledWith('/leaderboard');
    expect(back).not.toHaveBeenCalled();
  });

  it('never goes back off-site when the browser can tell', () => {
    // A prize link pasted into a used tab: history has entries, none of ours.
    vi.stubGlobal('navigation', { canGoBack: false });
    const button = renderClose(3);
    act(() => button?.click());
    expect(replace).toHaveBeenCalledWith('/leaderboard');
    expect(back).not.toHaveBeenCalled();
  });

  it('goes back when the browser confirms an entry of ours', () => {
    vi.stubGlobal('navigation', { canGoBack: true });
    const button = renderClose(1);
    act(() => button?.click());
    expect(back).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it('steps back once on a double tap, and works again after', () => {
    vi.useFakeTimers();
    const button = renderClose(3);
    act(() => {
      button?.click();
      button?.click();
    });
    expect(back).toHaveBeenCalledOnce();
    // A bfcache restore brings this same instance back, so it must not stay dead.
    vi.advanceTimersByTime(1000);
    act(() => button?.click());
    expect(back).toHaveBeenCalledTimes(2);
  });
});

describe('CardPage', () => {
  async function renderPage(searchParams: Record<string, string>) {
    const page = (await CardPage({
      params: Promise.resolve({ handle: 'mewtwo' }),
      searchParams: Promise.resolve(searchParams),
    })) as ReactElement;
    act(() => root.render(page));
  }

  it('gives a challenge prize a working Close, not All packs', async () => {
    vi.spyOn(History.prototype, 'length', 'get').mockReturnValue(3);
    await renderPage({ prize: 'weekly' });
    expect(container.textContent).not.toContain('All packs');
    const button = container.querySelector('button');
    expect(button?.textContent).toContain('Close');
    act(() => button?.click());
    expect(back).toHaveBeenCalledOnce();
  });

  it('keeps All packs for every other arrival', async () => {
    await renderPage({});
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/slots');
    expect(container.textContent).toContain('All packs');
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps the prize marker through a failed load retry', async () => {
    cardResult = { status: 'error' };
    await renderPage({ prize: 'weekly' });
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/card/mewtwo?prize=weekly',
    );
  });

  it('adds no prize marker to an ordinary retry', async () => {
    cardResult = { status: 'error' };
    await renderPage({});
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/card/mewtwo',
    );
  });
});
