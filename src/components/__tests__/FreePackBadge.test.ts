// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CONSENT_KEY } from '@/lib/consent';

// Plan 097: the badge fires an uncached fetch on EVERY client-side navigation
// for EVERY visitor (the 2026-07-07-incident class of chrome fan-out — see
// create-unread-dot.tsx). These pin the decision table that fixes it: the
// route skip (no fetch, no render on a page that owns a colliding z-40 dock),
// the own-page segment match (not a `startsWith` prefix match), a
// malformed-answer fail-to-hidden, and the 30s per-identity throttle.

let pathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

const authState: {
  customer: { id: string } | null;
  isLoading: boolean;
} = { customer: null, isLoading: false };
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => authState,
}));

// Sidesteps jsdom's missing window.matchMedia — no test here asserts on the
// idle-bob animation class, so a fixed stub is enough.
vi.mock('@/lib/use-reveal', () => ({
  usePrefersReducedMotion: () => true,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const okJson = (body: unknown) => ({ ok: true, json: async () => body });

const { GlobalFreePackBadge, isOwnFreePackPath, clearFreePackBadgeThrottle } =
  await import('../FreePackBadge');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  pathname = '/';
  authState.customer = null;
  authState.isLoading = false;
  fetchMock.mockReset();
  clearFreePackBadgeThrottle();
  window.localStorage.clear();
  // Decided (either value) — undecided (null) holds the badge, tested
  // separately isn't needed here since GlobalFreePackBadge's own render gate
  // (state.mode) is what these cases pin, not the consent hold.
  window.localStorage.setItem(CONSENT_KEY, 'accepted');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(createElement(GlobalFreePackBadge));
  });
}

describe('GlobalFreePackBadge', () => {
  test('/slots (the catalog) → no fetch fired', async () => {
    pathname = '/slots';
    fetchMock.mockResolvedValue(okJson({ mode: 'signup' }));

    await mount();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  test('/vault, /leaderboard, /slots/<slug> → no fetch, no render', async () => {
    for (const p of ['/vault', '/leaderboard', '/slots/some-pack']) {
      pathname = p;
      fetchMock.mockReset();
      // A claim answer, so a stray fetch would visibly render the badge —
      // proving the skip actually prevents the read, not just that state
      // happens to default to hidden.
      fetchMock.mockResolvedValue(
        okJson({ mode: 'claim', slug: 'free-welcome' }),
      );

      await mount();

      expect(fetchMock, `fetch fired on ${p}`).not.toHaveBeenCalled();
      expect(container.textContent, `rendered on ${p}`).toBe('');
    }
  });

  test('malformed fetch payload fails to hidden', async () => {
    pathname = '/';
    // mode:'claim' with no slug — not a valid claim, not a signup either.
    fetchMock.mockResolvedValue(okJson({ mode: 'claim' }));

    await mount();

    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-testid="free-pack-badge"]')).toBe(
      null,
    );
  });

  test('second navigation within 30s, same identity → one fetch; identity change refetches', async () => {
    pathname = '/';
    fetchMock.mockResolvedValue(okJson({ mode: 'signup' }));
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="free-pack-badge"]')).not.toBe(
      null,
    );

    // Second navigation, same (guest) identity, well inside the 30s window.
    pathname = '/about';
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The throttled reuse still applies the last known answer.
    expect(container.querySelector('[data-testid="free-pack-badge"]')).not.toBe(
      null,
    );

    // Identity flips guest → customer: busts the throttle immediately.
    authState.customer = { id: 'cus_1' };
    fetchMock.mockResolvedValue(
      okJson({ mode: 'claim', slug: 'free-welcome' }),
    );
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('isOwnFreePackPath — segment match, not prefix', () => {
  test('exact own-slug path matches', () => {
    expect(isOwnFreePackPath('/slots/free-welcome', 'free-welcome')).toBe(true);
  });

  test('a slug that merely PREFIXES the own slug does not match (the bug this pins)', () => {
    expect(isOwnFreePackPath('/slots/free-welcome-2', 'free-welcome')).toBe(
      false,
    );
  });

  test('the own slug on a different top-level route does not match', () => {
    expect(isOwnFreePackPath('/vault/free-welcome', 'free-welcome')).toBe(
      false,
    );
  });
});
