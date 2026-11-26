// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GAMES_EVENT } from '../games';
import { PHONE_TABS, TABS, isTabActive, markerIndex } from '../tabs';

// The Games tab (operator 2026-10-25) is the one tab that does not navigate:
// it opens the game picker. These pin that, that the game pages light Games
// rather than Task, and that Lucky Draw left Games for its own tab (2026-10-30).

const nav = { pathname: '/' };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: { id: 'cus_1' }, isLoading: false }),
}));
vi.mock('@/components/AuthButton', () => ({ openAuth: vi.fn() }));
vi.mock('@/components/AmbientVideo', () => ({ AmbientVideo: () => null }));
vi.mock('@/lib/use-liquid-glass', () => ({
  GLASS_SUBTLE: {},
  useLiquidGlass: () => {},
}));
vi.mock('../VaultDotProvider', () => ({
  useVaultDot: () => ({ show: false }),
}));
vi.mock('../DrawDotProvider', () => ({
  useDrawDot: () => ({ show: false }),
}));

const TabBar = (await import('../TabBar')).default;
const { TabLink } = await import('../TabLink');
// Loaded here, not in its test: under full-suite load this import alone can
// outlast the 5 s test timeout, and the late render then lands in the next test.
const { GamesSheetBody } = await import('../GamesSheetBody');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  nav.pathname = '/';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const games = TABS.find((t) => t.opens === 'games')!;
const task = TABS.find((t) => t.label === 'Task')!;
const draw = TABS.find((t) => t.label === 'Draw')!;

describe('Games tab', () => {
  test('the bar has seven tabs in the operator order, Home in the middle', () => {
    expect(TABS.map((t) => t.label)).toEqual([
      'Task',
      'Ranks',
      'Games',
      'Home',
      'Draw',
      'Vault',
      'Me',
    ]);
  });

  test('the game pages light Games, not Task', () => {
    for (const path of ['/coin-flip', '/coin-flip/x', '/vault/coin-flip']) {
      expect(isTabActive(games, path)).toBe(true);
      expect(isTabActive(task, path)).toBe(false);
      expect(
        isTabActive(
          TABS.find((t) => t.label === 'Vault')!,
          path,
        ),
      ).toBe(false);
    }
    expect(isTabActive(games, '/task')).toBe(false);
  });

  test('Lucky Draw lights its own tab, not Games or Task', () => {
    for (const path of ['/lucky-draw', '/lucky-draw/x']) {
      expect(isTabActive(draw, path)).toBe(true);
      expect(isTabActive(games, path)).toBe(false);
      expect(isTabActive(task, path)).toBe(false);
    }
  });

  test('the phone bar has five tabs, Home in the middle', () => {
    expect(PHONE_TABS.map((t) => t.label)).toEqual([
      'Rewards',
      'Play',
      'Home',
      'Vault',
      'Me',
    ]);
  });

  test('every destination lights exactly one phone tab', () => {
    const lit = (path: string) =>
      PHONE_TABS.filter((t) => isTabActive(t, path)).map((t) => t.label);
    expect(lit('/task')).toEqual(['Rewards']);
    expect(lit('/leaderboard')).toEqual(['Rewards']);
    expect(lit('/lucky-draw')).toEqual(['Play']);
    expect(lit('/vault/coin-flip')).toEqual(['Play']);
    expect(lit('/vault')).toEqual(['Vault']);
    expect(lit('/wallet')).toEqual(['Me']);
    expect(lit('/')).toEqual(['Home']);
  });

  test('the lit-tab marker sits on the lit tab, and hides for the raised Home and for no tab', () => {
    expect(markerIndex(TABS, '/vault')).toBe(5);
    expect(markerIndex(TABS, '/')).toBe(3);
    expect(markerIndex(PHONE_TABS, '/wallet')).toBe(4);
    // Home lights itself on the phone bar.
    expect(markerIndex(PHONE_TABS, '/')).toBe(-1);
    expect(markerIndex(PHONE_TABS, '/terms')).toBe(-1);
  });

  test('Play goes to the Lucky Draw page, and only for a signed-in customer', async () => {
    expect(draw.gated).toBe(true);
    expect(PHONE_TABS.find((t) => t.label === 'Play')?.gated).toBe(true);
    await act(async () => root.render(createElement(TabBar)));
    const link = container.querySelector('a[href="/lucky-draw"]');
    expect(link?.textContent).toBe('Play');
  });

  // The desktop header's link; the phone bar has no Games tab.
  test('tapping Games opens the picker instead of navigating', async () => {
    await act(async () =>
      root.render(createElement(TabLink, { tab: games, variant: 'pill' })),
    );
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Games',
    )!;
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(container.querySelector('a[href="/coin-flip"]')).toBeNull();

    const opened = vi.fn();
    window.addEventListener(GAMES_EVENT, opened);
    await act(async () => button.click());
    window.removeEventListener(GAMES_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  test('Coin Flip is open: the tile goes to the game', async () => {
    await act(async () =>
      root.render(createElement(GamesSheetBody, { openedOn: '/' })),
    );
    expect(document.body.textContent).not.toContain('Coming soon');
    expect(document.querySelector('a[href="/vault/coin-flip"]')).not.toBeNull();
  });

  test('Play shows as current while a game is open', async () => {
    nav.pathname = '/vault/coin-flip';
    await act(async () => root.render(createElement(TabBar)));
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe('Play');
  });
});
