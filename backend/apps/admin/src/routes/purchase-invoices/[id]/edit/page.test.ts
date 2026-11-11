// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditPurchaseInvoicePage from './page';

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
  getPurchaseInvoice: api.get,
  updatePurchaseInvoice: api.update,
  listPurchaseInvoices: vi.fn(async () => ({
    total: 0,
    offset: 0,
    limit: 50,
    invoices: [],
  })),
  listInventory: vi.fn(async () => ({ rows: [] })),
}));
vi.mock('@medusajs/ui', async (original) => ({
  ...(await original<typeof import('@medusajs/ui')>()),
  toast,
  usePrompt: () => prompt,
}));

// User 2026-11-11: staff correct a saved purchase invoice instead of
// reversing it and typing it again.
const invoice = (over: Record<string, unknown> = {}) => ({
  invoice: {
    id: 'pinv_1',
    display_no: 'PI-00007',
    date: '2026-11-10T16:00:00.000Z',
    supplier: 'Typo Supplier',
    agent_user_id: 'user_1',
    agent_email: null,
    reverses_invoice_id: null,
    from_grn_id: null,
    from_grn_display_no: null,
    reversed_by: null,
    created_at: '2026-11-11T02:00:00.000Z',
    updated_at: '2026-11-11T03:00:00.000Z',
    lines: [
      {
        id: 'pil_1',
        invoice_id: 'pinv_1',
        card_handle: 'abra',
        card_name: 'Abra',
        fmv_snapshot: '10',
        qty: 3,
        unit_cost: '8',
        line_total: '24',
      },
    ],
    ...over,
  },
});

describe('purchase invoice edit page', () => {
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
  async function mount(over: Record<string, unknown> = {}) {
    api.get.mockResolvedValue(invoice(over));
    api.update.mockResolvedValue({ invoice: { id: 'pinv_1' } });
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
            { initialEntries: ['/purchase-invoices/pinv_1/edit'] },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: '/purchase-invoices/:id/edit',
                element: createElement(EditPurchaseInvoicePage),
              }),
              createElement(Route, {
                path: '/purchase-invoices/:id',
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
      (b) => b.textContent === 'pi.save',
    );
  const input = (label: string) =>
    host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  const type = (label: string, value: string) =>
    act(async () => {
      const el = input(label)!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('refuses an invoice someone already reversed, with no form', async () => {
    await mount({ reversed_by: { id: 'pinv_2', display_no: 'PI-00008' } });
    expect(host.textContent).toContain('pi.notEditableReversed');
    expect(save()).toBeUndefined();
  });

  it('starts from the saved invoice, warns before fewer cards, and sends its version', async () => {
    await mount();
    expect(input('Line 1 quantity')!.value).toBe('3');
    expect(input('Line 1 unit cost')!.value).toBe('8.00');
    // An edit keeps what the invoice is: no reversal or transfer pick.
    expect(host.textContent).not.toContain('Reverses invoice');
    expect(host.textContent).not.toContain('grn.transfer.button');

    await type('Line 1 quantity', '1');
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
    expect(id).toBe('pinv_1');
    expect(body).toEqual({
      date: '2026-11-10T16:00:00.000Z',
      supplier: 'Typo Supplier',
      expected_updated_at: '2026-11-11T03:00:00.000Z',
      lines: [
        {
          card_handle: 'abra',
          card_name: 'Abra',
          fmv_snapshot: 10,
          qty: 1,
          unit_cost: 8,
        },
      ],
    });
    // Polled: the save awaits the invalidations' refetch before it navigates.
    await vi.waitFor(async () => {
      await settle();
      expect(host.textContent).toContain('detail page');
    });
  });

  it('an invoice from a GRN opens its supplier and unit cost, not its cards', async () => {
    await mount({ from_grn_id: 'grn_1', from_grn_display_no: 'GRN-00003' });
    expect(host.textContent).toContain('pi.editSubtitleTransfer');
    expect(input('Line 1 quantity')).toBeNull();
    expect(input('Line 1 FMV')).toBeNull();
    const supplier = host.querySelector<HTMLInputElement>('#pi-supplier')!;
    expect(supplier.value).toBe('Typo Supplier');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(supplier, 'Right Supplier Sdn Bhd');
      supplier.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await type('Line 1 unit cost', '9.50');
    await act(async () => save()!.click());
    await settle();
    expect(prompt).not.toHaveBeenCalled();
    expect(api.update.mock.calls[0][1].supplier).toBe('Right Supplier Sdn Bhd');
    expect(api.update.mock.calls[0][1].lines).toEqual([
      {
        card_handle: 'abra',
        card_name: 'Abra',
        fmv_snapshot: 10,
        qty: 3,
        unit_cost: 9.5,
      },
    ]);
  });
});
