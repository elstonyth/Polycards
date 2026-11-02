// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The root layout's on-demand pieces: a request made before, or while, the chunk
// loads must still reach the piece once it arrives.

vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: null, isLoading: false }),
}));
vi.mock('@/components/AuthModal', () => ({
  default: ({ opening }: { opening: CustomEvent | null }) =>
    createElement('div', {
      'data-testid': 'auth',
      'data-mode': opening?.detail?.mode ?? 'none',
    }),
}));
vi.mock('@/components/app-shell/GamesSheetBody', () => ({
  GamesSheetBody: ({ openedOn }: { openedOn: string }) =>
    createElement('div', { 'data-testid': 'games', 'data-on': openedOn }),
}));

const { default: AuthModalLoader } = await import('../AuthModalLoader');
const { GamesSheet } = await import('../app-shell/GamesSheet');
const { GAMES_EVENT } = await import('../app-shell/games');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const openAuth = (mode: string) =>
  window.dispatchEvent(new CustomEvent('polycards:auth', { detail: { mode } }));
const settle = () =>
  act(async () => {
    await vi.dynamicImportSettled();
  });
const piece = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AuthModalLoader', () => {
  it('mounts nothing until asked, then hands over the request', async () => {
    await act(async () => root.render(createElement(AuthModalLoader)));
    expect(piece('auth')).toBeNull();
    await act(async () => openAuth('signup'));
    await settle();
    expect(piece('auth')?.getAttribute('data-mode')).toBe('signup');
  });

  it('hands over the latest request made while the chunk loads', async () => {
    await act(async () => root.render(createElement(AuthModalLoader)));
    await act(async () => {
      openAuth('login');
      openAuth('signup');
    });
    await settle();
    expect(piece('auth')?.getAttribute('data-mode')).toBe('signup');
  });

  it('mounts for a ?auth= arrival with no event to hand over', async () => {
    window.history.replaceState({}, '', '/?auth=login');
    await act(async () => root.render(createElement(AuthModalLoader)));
    await settle();
    expect(piece('auth')?.getAttribute('data-mode')).toBe('none');
  });
});

describe('GamesSheet', () => {
  it('opens on the page the tap came from, not the one the chunk lands on', async () => {
    await act(async () => root.render(createElement(GamesSheet)));
    expect(piece('games')).toBeNull();
    window.history.replaceState({}, '', '/slots');
    await act(async () => {
      window.dispatchEvent(new Event(GAMES_EVENT));
    });
    window.history.replaceState({}, '', '/vault');
    await settle();
    expect(piece('games')?.getAttribute('data-on')).toBe('/slots');
  });
});
