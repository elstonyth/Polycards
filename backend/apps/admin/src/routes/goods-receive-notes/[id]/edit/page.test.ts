// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditGoodsReceiveNotePage from './page';

// Injected by the dashboard Vite plugin at build time; lib/client.ts reads it on
// load, which is before this file's body runs.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__BACKEND_URL__ =
    'http://backend.test';
});
const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
const prompt = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../../../lib/admin-rest', async (original) => ({
  ...(await original<typeof import('../../../../lib/admin-rest')>()),
  getGoodsReceiveNote: api.get,
  updateGoodsReceiveNote: api.update,
}));
vi.mock('@medusajs/ui', async (original) => ({
  ...(await original<typeof import('@medusajs/ui')>()),
  toast,
  usePrompt: () => prompt,
}));

const note = (status: string) => ({
  goods_receive_note: {
    id: 'grn_1',
    display_no: 'GRN-00001',
    date: '2026-11-02T16:00:00.000Z',
    supplier: 'Typo Supplier',
    updated_at: '2026-11-03T10:00:00.000Z',
    status,
    lines: [
      {
        id: 'line_1',
        grn_id: 'grn_1',
        card_handle: 'abra',
        card_name: 'Abra',
        fmv_snapshot: '10',
        qty: 3,
      },
    ],
  },
});

describe('GRN edit page', () => {
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

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  async function mount(status: string) {
    api.get.mockResolvedValue(note(status));
    api.update.mockResolvedValue({ goods_receive_note: { id: 'grn_1' } });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            MemoryRouter,
            { initialEntries: ['/goods-receive-notes/grn_1/edit'] },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: '/goods-receive-notes/:id/edit',
                element: createElement(EditGoodsReceiveNotePage),
              }),
              createElement(Route, {
                path: '/goods-receive-notes/:id',
                element: createElement('p', null, 'detail page'),
              }),
            ),
          ),
        ),
      );
    });
    await settle();
  }
  const save = () =>
    [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'grn.save',
    );
  const setQty = (value: string) =>
    act(async () => {
      const input = host.querySelector<HTMLInputElement>(
        'input[aria-label="grn.lineQty"]',
      )!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('refuses a GRN that is no longer open, with no form', async () => {
    await mount('transferred');
    expect(host.textContent).toContain('grn.notEditable');
    expect(save()).toBeUndefined();
  });

  it('warns before saving fewer cards, and saves nothing on Cancel', async () => {
    await mount('open');
    expect(
      host.querySelector<HTMLInputElement>('input[aria-label="grn.lineQty"]')!
        .value,
    ).toBe('3');
    await setQty('1');
    prompt.mockResolvedValueOnce(false);
    await act(async () => save()!.click());
    await settle();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(api.update).not.toHaveBeenCalled();

    prompt.mockResolvedValueOnce(true);
    await act(async () => save()!.click());
    await settle();
    expect(api.update).toHaveBeenCalledTimes(1);
    const [id, body] = api.update.mock.calls[0];
    expect(id).toBe('grn_1');
    expect(body).toMatchObject({
      supplier: 'Typo Supplier',
      expected_updated_at: '2026-11-03T10:00:00.000Z',
      lines: [
        { card_handle: 'abra', card_name: 'Abra', fmv_snapshot: 10, qty: 1 },
      ],
    });
    // Polled, not one fixed settle(): the save awaits the stock invalidation's
    // refetch before it navigates, which can outlast 20 ms on a loaded CI box.
    await vi.waitFor(async () => {
      await settle();
      expect(host.textContent).toContain('detail page');
    });
  });

  it('saves more cards straight away', async () => {
    await mount('open');
    await setQty('5');
    await act(async () => save()!.click());
    await settle();
    expect(prompt).not.toHaveBeenCalled();
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][1].lines[0].qty).toBe(5);
  });
});
