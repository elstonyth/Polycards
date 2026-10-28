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
import { AuthProvider } from '../AuthProvider';

// The admin Dashboard's "online now" counts a player while their latest
// presence ping is under 5 minutes old. Pinned here: a signed-in, visible tab
// pings on sign-in and every 2 minutes; a hidden tab pings nothing and pings
// again the moment it is visible; a logged-out visitor never pings.

let me: { customer: { id: string } | null };
const fetchMock = vi.fn(async (url: string) =>
  url === '/api/me'
    ? new Response(JSON.stringify(me), { status: 200 })
    : new Response(null, { status: 204 }),
);
const pings = () =>
  fetchMock.mock.calls.filter(([url]) => url === '/api/presence').length;

let visibility: DocumentVisibilityState = 'visible';
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  visibility = 'visible';
  me = { customer: { id: 'cus_1' } };
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mount = async () => {
  await act(async () => {
    root.render(createElement(AuthProvider, null, null));
  });
  // Let /api/me resolve and the signed-in render commit.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe('presence heartbeat', () => {
  it('pings on sign-in and every 2 minutes while visible', async () => {
    await mount();
    expect(pings()).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/presence', {
      method: 'POST',
      cache: 'no-store',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(pings()).toBe(2);
  });

  it('pings nothing while hidden, and again when the tab comes back', async () => {
    await mount();
    visibility = 'hidden';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60_000);
    });
    expect(pings()).toBe(1);
    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(pings()).toBe(2);
  });

  it('never pings for a logged-out visitor', async () => {
    me = { customer: null };
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60_000);
    });
    expect(pings()).toBe(0);
  });
});
