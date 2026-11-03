// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InventoryListPage from './page';

// Injected by the dashboard Vite plugin at build time; lib/client.ts reads it on
// load, which is before this file's body runs.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__BACKEND_URL__ =
    'http://backend.test';
});
const permissions = vi.hoisted(() => ({ canMoveOrders: false }));
const api = vi.hoisted(() => ({ list: vi.fn(), allocate: vi.fn() }));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../lib/admin-rest', async (original) => ({
  ...(await original<typeof import('../../../lib/admin-rest')>()),
  listInventory: api.list,
  allocateDeliveryOrders: api.allocate,
}));
vi.mock('@mercurjs/admin', () => ({
  usePermissions: () => ({
    hasAllPermissions: (list: string[]) =>
      list.includes('delivery_order:update') && permissions.canMoveOrders,
  }),
}));
vi.mock('@medusajs/ui', async (original) => ({
  ...(await original<typeof import('@medusajs/ui')>()),
  toast,
}));

describe('Stock page Refresh', () => {
  let root: Root | undefined;
  let host: HTMLDivElement;
  let client: QueryClient;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    client?.clear();
    vi.clearAllMocks();
  });

  const refresh = () =>
    [...host.querySelectorAll('button')].find((item) =>
      /refresh/i.test(item.textContent ?? ''),
    )!;
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  async function mount(canMoveOrders: boolean) {
    permissions.canMoveOrders = canMoveOrders;
    api.list.mockResolvedValue({ rows: [] });
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MemoryRouter, null, createElement(InventoryListPage)),
        ),
      );
    });
    await settle();
    expect(api.list).toHaveBeenCalledTimes(1);
  }

  it('moves orders once on a double-click, reloads, then says how many moved', async () => {
    api.allocate.mockResolvedValue({ ready: 2, failed: 0 });
    await mount(true);
    // The same tick: the second click lands before the disabled render.
    await act(async () => {
      refresh().click();
      refresh().click();
    });
    await settle();
    expect(api.allocate).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(api.list.mock.invocationCallOrder[1]).toBeLessThan(
      toast.success.mock.invocationCallOrder[0],
    );
    expect(refresh().disabled).toBe(false);
  });

  it('warns when some orders could not finish moving', async () => {
    api.allocate.mockResolvedValue({ ready: 0, failed: 1 });
    await mount(true);
    await act(async () => refresh().click());
    await settle();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('only reloads the numbers for staff who cannot move orders', async () => {
    await mount(false);
    await act(async () => refresh().click());
    await settle();
    expect(api.allocate).not.toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(refresh().disabled).toBe(false);
  });

  it('a failed move still reloads, says why, and can be pressed again', async () => {
    api.allocate.mockRejectedValueOnce(new Error('boom'));
    api.allocate.mockResolvedValue({ ready: 0, failed: 0 });
    await mount(true);
    await act(async () => refresh().click());
    await settle();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledWith('boom');
    expect(refresh().disabled).toBe(false);
    await act(async () => refresh().click());
    await settle();
    expect(api.allocate).toHaveBeenCalledTimes(2);
  });
});
