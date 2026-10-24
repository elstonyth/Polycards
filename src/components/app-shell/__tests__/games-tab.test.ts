// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GAMES_EVENT } from '../games';
import { TABS, isTabActive } from '../tabs';

// The Games tab (operator 2026-10-25) is the one tab that does not navigate:
// it opens the game picker. These pin that, and that the game pages light
// Games rather than Task (Task used to own /lucky-draw).

const nav = { pathname: '/' };
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: { id: 'cus_1' }, isLoading: false }),
}));
vi.mock('@/components/AuthButton', () => ({ openAuth: vi.fn() }));
vi.mock('../VaultDotProvider', () => ({
  useVaultDot: () => ({ show: false }),
}));

const TabBar = (await import('../TabBar')).default;

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

describe('Games tab', () => {
  test('the bar has six tabs in the operator order', () => {
    expect(TABS.map((t) => t.label)).toEqual([
      'Task',
      'Ranks',
      'Games',
      'Home',
      'Vault',
      'Me',
    ]);
  });

  test('the game pages light Games, not Task', () => {
    for (const path of ['/lucky-draw', '/coin-flip', '/coin-flip/x']) {
      expect(isTabActive(games, path)).toBe(true);
      expect(isTabActive(task, path)).toBe(false);
    }
    expect(isTabActive(games, '/task')).toBe(false);
  });

  test('tapping Games opens the picker instead of navigating', async () => {
    await act(async () => root.render(createElement(TabBar)));
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Games',
    )!;
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(container.querySelector('a[href="/lucky-draw"]')).toBeNull();

    const opened = vi.fn();
    window.addEventListener(GAMES_EVENT, opened);
    await act(async () => button.click());
    window.removeEventListener(GAMES_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  test('Games shows as current while a game is open', async () => {
    nav.pathname = '/lucky-draw';
    await act(async () => root.render(createElement(TabBar)));
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe('Games');
  });
});
