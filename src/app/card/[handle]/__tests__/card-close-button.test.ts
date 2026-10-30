// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  createElement,
  type AnchorHTMLAttributes,
  type ReactElement,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';

const back = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back, push }),
  notFound: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', props),
}));
vi.mock('@/lib/data/cards', () => ({
  getCardResult: async () => ({ status: 'ok', card: { handle: 'mewtwo' } }),
}));
vi.mock('../CardDetailHydrated', () => ({ CardDetailHydrated: () => null }));

const { CardCloseButton } = await import('../CardCloseButton');
const { default: CardPage } = await import('../page');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('CardCloseButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    back.mockClear();
    push.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function clickClose(historyLength: number) {
    vi.spyOn(History.prototype, 'length', 'get').mockReturnValue(historyLength);
    act(() => root.render(createElement(CardCloseButton)));
    const button = container.querySelector('button');
    expect(button?.textContent).toContain('Close');
    act(() => button?.click());
  }

  it('goes back to where the prize was tapped', () => {
    clickClose(3);
    expect(back).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });

  it('opens the leaderboard when there is nothing to go back to', () => {
    clickClose(1);
    expect(push).toHaveBeenCalledWith('/leaderboard');
    expect(back).not.toHaveBeenCalled();
  });

  it('never goes back off-site when the browser can tell', () => {
    // A prize link pasted into a used tab: history has entries, none of ours.
    vi.stubGlobal('navigation', { canGoBack: false });
    clickClose(3);
    expect(push).toHaveBeenCalledWith('/leaderboard');
    expect(back).not.toHaveBeenCalled();
  });

  it('goes back when the browser confirms an entry of ours', () => {
    vi.stubGlobal('navigation', { canGoBack: true });
    clickClose(1);
    expect(back).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('CardPage back control', () => {
  async function markup(searchParams: Record<string, string>) {
    const page = (await CardPage({
      params: Promise.resolve({ handle: 'mewtwo' }),
      searchParams: Promise.resolve(searchParams),
    })) as ReactElement;
    return renderToStaticMarkup(page);
  }

  it('offers Close on a challenge prize, not All packs', async () => {
    const html = await markup({ prize: 'weekly' });
    expect(html).toContain('Close');
    expect(html).not.toContain('All packs');
  });

  it('keeps All packs for every other arrival', async () => {
    const html = await markup({});
    expect(html).toContain('All packs');
    expect(html).not.toContain('Close');
  });
});
