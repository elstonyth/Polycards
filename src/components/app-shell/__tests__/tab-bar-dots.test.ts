// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The dots are wired by a hard-coded href match in TabBar, and nothing else
// checks that wiring: swap '/vault' for '/me' and every other test still
// passes. These pin which destination each dot lands on, and that a dot is
// announced rather than being colour-only.

const vaultDot = { show: false };
const creditDot = { show: false };

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: { id: 'cus_1' }, isLoading: false }),
}));
vi.mock('@/components/AuthButton', () => ({ openAuth: vi.fn() }));
vi.mock('../VaultDotProvider', () => ({
  useVaultDot: () => vaultDot,
}));
vi.mock('../CreditDotProvider', () => ({
  useCreditDot: () => creditDot,
}));

const TabBar = (await import('../TabBar')).default;

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vaultDot.show = false;
  creditDot.show = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(createElement(TabBar));
  });
}

/** The accessible name of the tab pointing at `href`. */
function labelFor(href: string): string | null {
  return (
    container.querySelector(`a[href="${href}"]`)?.getAttribute('aria-label') ??
    null
  );
}

describe('TabBar dots', () => {
  test('renders no dot when neither surface has news', async () => {
    await render();

    expect(labelFor('/vault')).toBeNull();
    expect(labelFor('/me')).toBeNull();
  });

  test('the vault dot lands on /vault and nowhere else', async () => {
    vaultDot.show = true;
    await render();

    expect(labelFor('/vault')).toBe('Vault, new items');
    expect(labelFor('/me')).toBeNull();
    expect(labelFor('/')).toBeNull();
  });

  // The two dots signal DIFFERENT things, so they announce differently: the
  // vault gains cards, /me gains balance movement. A shared "new items" told a
  // screen-reader user the wrong content type on /me (review finding).
  test('the money dot lands on /me and nowhere else', async () => {
    creditDot.show = true;
    await render();

    expect(labelFor('/me')).toBe('Me, new activity');
    expect(labelFor('/vault')).toBeNull();
  });

  test('both can be lit at once without bleeding into other tabs', async () => {
    vaultDot.show = true;
    creditDot.show = true;
    await render();

    expect(labelFor('/vault')).toBe('Vault, new items');
    expect(labelFor('/me')).toBe('Me, new activity');
    // The other three destinations never take a dot.
    for (const href of ['/task', '/leaderboard', '/']) {
      expect(labelFor(href)).toBeNull();
    }
  });
});
