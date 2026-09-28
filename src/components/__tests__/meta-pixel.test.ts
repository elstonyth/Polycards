// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CONSENT_EVENT, CONSENT_KEY } from '@/lib/consent';

// When the Meta Pixel loads at all: only after an Accept (in this tab or
// another), never on a tokenized route, and a "no" drops what was held.

vi.mock('next/script', () => ({
  default: ({ id }: { id: string }) =>
    createElement('script', { 'data-pixel': id }),
}));
let pathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
// Tests run a test build; this component is only live in production ones.
vi.mock('@/lib/pixel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pixel')>()),
  PIXEL_ENABLED: true,
}));
// jsdom can't navigate; a reload is observed through the navigation seam.
const reloadPage = vi.fn();
vi.mock('@/lib/navigation', () => ({ reloadPage: () => reloadPage() }));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  pathname = '/';
  reloadPage.mockClear();
  delete window.polycardsPixelQueue;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  const { default: MetaPixel } = await import('../MetaPixel');
  await act(async () => {
    root.render(createElement(MetaPixel));
  });
}
const loaded = () => container.querySelector('[data-pixel="meta-pixel"]');

describe('MetaPixel', () => {
  it('loads nothing until the visitor accepts, then loads', async () => {
    await mount();
    expect(loaded()).toBeNull();

    localStorage.setItem(CONSENT_KEY, 'accepted');
    await act(async () => {
      window.dispatchEvent(new Event(CONSENT_EVENT));
    });
    expect(loaded()).not.toBeNull();
  });

  // Otherwise this tab keeps holding events for a pixel it never loads.
  it('loads when the visitor accepts in another tab', async () => {
    await mount();
    localStorage.setItem(CONSENT_KEY, 'accepted');
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: CONSENT_KEY }));
    });
    expect(loaded()).not.toBeNull();
  });

  it('never loads on a route carrying a credential in its URL', async () => {
    localStorage.setItem(CONSENT_KEY, 'accepted');
    pathname = '/reset-password';
    await mount();
    expect(loaded()).toBeNull();
  });

  // fbevents.js can't be unloaded, so a "no" after this page loaded it needs
  // a fresh page.
  it('reloads once when a "no" follows a pixel this page loaded', async () => {
    localStorage.setItem(CONSENT_KEY, 'accepted');
    await mount();
    expect(loaded()).not.toBeNull();

    localStorage.setItem(CONSENT_KEY, 'rejected');
    await act(async () => {
      window.dispatchEvent(new Event(CONSENT_EVENT));
    });
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  // Something else (an extension, another tag) defining fbq must never turn
  // a visitor's "no" into a reload loop.
  it('never reloads a page that did not load the pixel itself', async () => {
    window.fbq = Object.assign(() => {}, { callMethod: () => {} });
    localStorage.setItem(CONSENT_KEY, 'rejected');
    await mount();
    expect(reloadPage).not.toHaveBeenCalled();
    delete window.fbq;
  });

  it('drops held events when the answer is no', async () => {
    window.polycardsPixelQueue = [() => {}];
    await mount();
    localStorage.setItem(CONSENT_KEY, 'rejected');
    await act(async () => {
      window.dispatchEvent(new Event(CONSENT_EVENT));
    });
    expect(loaded()).toBeNull();
    expect(window.polycardsPixelQueue).toEqual([]);
  });
});
