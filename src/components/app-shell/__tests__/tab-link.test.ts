// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type Mock,
} from 'vitest';
import {
  act,
  createElement,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';

// TabLink is the one item both the phone bar and the desktop header render.
// These pin what moved into it from both: a visitor never prefetches a gated
// route (on either variant), a gated tap made before auth answers waits for
// the answer, re-tapping the tab you are on scrolls to the top instead of
// navigating, and the Games button warms its sheet on the press.

const nav = { pathname: '/' };
const push = vi.fn();
const auth: { customer: { id: string } | null; isLoading: boolean } = {
  customer: null,
  isLoading: false,
};
const status = { pending: false };
/** Per click on a mocked Link: the href when the click went through to
 *  navigation, null when TabLink prevented it. */
const navigations: (string | null)[] = [];

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push }),
}));
// The real Link strips `prefetch` from the DOM; this one shows it, and
// records whether a click was let through.
vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    onClick,
    children,
    transitionTypes: _transitionTypes,
    ...rest
  }: {
    href: string;
    prefetch?: boolean;
    onClick?: (e: ReactMouseEvent<HTMLAnchorElement>) => void;
    children: ReactNode;
    transitionTypes?: string[];
  }) =>
    createElement(
      'a',
      {
        ...rest,
        href,
        'data-prefetch': String(prefetch),
        onClick: (e: ReactMouseEvent<HTMLAnchorElement>) => {
          onClick?.(e);
          navigations.push(e.defaultPrevented ? null : href);
          e.preventDefault();
        },
      },
      children,
    ),
  useLinkStatus: () => status,
}));
vi.mock('@/components/auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('@/components/AuthButton', () => ({ openAuth: vi.fn() }));
vi.mock('../VaultDotProvider', () => ({
  useVaultDot: () => ({ show: false }),
}));
vi.mock('../DrawDotProvider', () => ({ useDrawDot: () => ({ show: false }) }));
vi.mock('../GamesSheet', () => ({ preloadGamesSheet: vi.fn() }));

const { TabLink } = await import('../TabLink');
const { TABS } = await import('../tabs');
const { openAuth } = await import('@/components/AuthButton');
const { preloadGamesSheet } = await import('../GamesSheet');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (label: string) => TABS.find((t) => t.label === label)!;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  nav.pathname = '/';
  auth.customer = null;
  auth.isLoading = false;
  status.pending = false;
  navigations.length = 0;
  push.mockClear();
  (openAuth as Mock).mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(label: string, variant: 'bar' | 'pill' = 'bar') {
  await act(async () => {
    root.render(createElement(TabLink, { tab: tab(label), variant }));
  });
}

async function click(el: Element | null) {
  await act(async () => {
    el?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    );
  });
}

describe('TabLink: the visitor prefetch guard', () => {
  for (const variant of ['bar', 'pill'] as const) {
    test(`${variant}: a visitor never prefetches a gated tab`, async () => {
      for (const label of ['Draw', 'Vault', 'Me']) {
        await render(label, variant);
        expect(container.querySelector('a')?.dataset.prefetch).toBe('false');
      }
      // Open tabs keep Next's default prefetch.
      await render('Task', variant);
      expect(container.querySelector('a')?.dataset.prefetch).toBe('undefined');
    });

    test(`${variant}: a signed-in customer prefetches gated tabs`, async () => {
      auth.customer = { id: 'cus_1' };
      await render('Vault', variant);
      expect(container.querySelector('a')?.dataset.prefetch).toBe('undefined');
    });
  }
});

describe('TabLink: a gated tap while auth is loading', () => {
  test('waits, then goes to the page for a signed-in customer', async () => {
    auth.isLoading = true;
    await render('Vault');
    await click(container.querySelector('a'));
    expect(navigations).toEqual([null]);
    expect(push).not.toHaveBeenCalled();
    expect(openAuth).not.toHaveBeenCalled();

    auth.isLoading = false;
    auth.customer = { id: 'cus_1' };
    await render('Vault');
    expect(push).toHaveBeenCalledWith('/vault');
    expect(openAuth).not.toHaveBeenCalled();
  });

  test('waits, then opens signup in place for a visitor', async () => {
    auth.isLoading = true;
    await render('Me');
    await click(container.querySelector('a'));

    auth.isLoading = false;
    await render('Me');
    expect(openAuth).toHaveBeenCalledWith('signup');
    expect(push).not.toHaveBeenCalled();
  });

  test('navigates as before when auth has not answered in 1.5 s', async () => {
    vi.useFakeTimers();
    auth.isLoading = true;
    await render('Draw');
    await click(container.querySelector('a'));
    await act(async () => {
      vi.advanceTimersByTime(1499);
    });
    expect(push).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(push).toHaveBeenCalledWith('/lucky-draw');
    expect(push).toHaveBeenCalledTimes(1);
  });

  test('a visitor tap after auth answered opens signup at once', async () => {
    await render('Vault');
    await click(container.querySelector('a'));
    expect(navigations).toEqual([null]);
    expect(openAuth).toHaveBeenCalledWith('signup');
  });
});

describe('TabLink: re-tapping the tab you are on', () => {
  test('scrolls to the top instead of navigating', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    auth.customer = { id: 'cus_1' };
    nav.pathname = '/vault';
    await render('Vault');
    await click(container.querySelector('a'));
    expect(navigations).toEqual([null]);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    vi.unstubAllGlobals();
  });

  test('on the page with a query, the tap still goes to the plain page', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    window.history.replaceState({}, '', '/?category=poly');
    await render('Home');
    await click(container.querySelector('a'));
    expect(navigations).toEqual(['/']);
    expect(scrollTo).not.toHaveBeenCalled();
    window.history.replaceState({}, '', '/');
    vi.unstubAllGlobals();
  });

  test('Home is lit on the home preview, which serves "/" under its switch', async () => {
    nav.pathname = '/home-preview';
    await render('Home');
    expect(container.querySelector('a')?.getAttribute('aria-current')).toBe(
      'page',
    );
  });

  test('a page that takes the Home tap itself cancels the scroll and the move', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    const take = (e: Event) => e.preventDefault();
    window.addEventListener('home-tab-tap', take);
    nav.pathname = '/slots/151';
    await render('Home');
    await click(container.querySelector('a'));
    expect(navigations).toEqual([null]);
    expect(scrollTo).not.toHaveBeenCalled();
    window.removeEventListener('home-tab-tap', take);
    vi.unstubAllGlobals();
  });

  test('a tab lit by a page under it still navigates to its own page', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    auth.customer = { id: 'cus_1' };
    // Me is lit on /settings, but its page is /me.
    nav.pathname = '/settings';
    await render('Me');
    expect(container.querySelector('a')?.getAttribute('aria-current')).toBe(
      'page',
    );
    await click(container.querySelector('a'));
    expect(navigations).toEqual(['/me']);
    expect(scrollTo).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('TabLink: feedback', () => {
  test('a pending tab takes its active colour after a delay', async () => {
    status.pending = true;
    await render('Task');
    const face = container.querySelector('a > span');
    expect(face?.className).toContain('text-neutral-50');
    expect(face?.className).toContain('delay-100');
    // Lit, not active: aria-current stays with the page actually shown.
    expect(container.querySelector('a')?.getAttribute('aria-current')).toBe(
      null,
    );
  });

  // From pointer events, not :active: Chrome on touch applies :active only
  // once a touch is known to be a tap, which left a short tap without feedback.
  test('the press shows from pointerdown until the pointer lifts', async () => {
    await render('Task');
    const link = container.querySelector('a')!;
    expect(link.hasAttribute('data-pressed')).toBe(false);
    await act(async () => {
      link.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(link.hasAttribute('data-pressed')).toBe(true);
    await act(async () => {
      link.dispatchEvent(new Event('pointerup', { bubbles: true }));
    });
    expect(link.hasAttribute('data-pressed')).toBe(false);
  });

  test('the Games button warms its sheet on the press', async () => {
    await render('Games');
    const button = container.querySelector('button');
    expect(button?.textContent).toBe('Games');
    await act(async () => {
      button?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(preloadGamesSheet).toHaveBeenCalled();
  });
});
