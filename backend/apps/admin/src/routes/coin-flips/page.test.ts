// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CoinFlipsPage, { config, handle } from './page';

const permissions = vi.hoisted(() => ({ canEdit: false }));
const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('../../lib/admin-rest', () => ({
  getCoinFlipSettings: api.read,
  saveCoinFlipSettings: api.save,
  listCoinFlips: vi.fn(),
  httpStatus: () => undefined,
}));
vi.mock('@mercurjs/admin', () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) =>
      permission === 'coin_flip:update' && permissions.canEdit,
  }),
}));

const render = (canEdit: boolean) => {
  permissions.canEdit = canEdit;
  const client = new QueryClient();
  client.setQueryData(['coin-flip-settings'], {
    enabled: true,
    win_percent: 40,
    win_percent_2: null,
    win_percent_3: null,
    published_win_percent: 50,
    revision: 2,
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(CoinFlipsPage),
    ),
  );
};

describe('coin flip admin permissions', () => {
  it('requires the coin read policy for navigation and direct links', () => {
    expect(config.permissions).toEqual(['coin_flip:read']);
    expect(handle.permissions).toBe('coin_flip:read');
  });

  it('shows settings without editable fields or save controls for read-only staff', () => {
    const html = render(false);
    expect(html).toContain('revision 2');
    expect(html).toContain('40%');
    expect(html.match(/<input\b[^>]*disabled=""/g)).toHaveLength(5);
    expect(html).not.toContain('Maximum total stake');
    expect(html).not.toContain('coin-max_stake_amount');
    expect(html).not.toContain('id="coin-reason"');
    expect(html).not.toMatch(/<button\b[^>]*>Save<\/button>/);
  });

  it('keeps the audit reason and editing controls for coin operators', () => {
    const html = render(true);
    expect(html).toContain('id="coin-reason"');
    expect(html).not.toMatch(/<input\b[^>]*disabled=""/);
  });
});

describe('coin flip editing lifetime', () => {
  let root: Root | undefined;
  let host: HTMLDivElement;
  let client: QueryClient;
  const saved = {
    enabled: true,
    win_percent: 40,
    win_percent_2: null,
    win_percent_3: null,
    published_win_percent: 50,
    revision: 2,
  };
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    client?.clear();
    vi.clearAllMocks();
  });

  const field = (id: string) =>
    host.querySelector<HTMLInputElement>(`#coin-${id}`)!;
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find(
      (item) => item.textContent === text,
    )!;
  async function edit(id: string, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(field(id), value);
      field(id).dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function mount() {
    permissions.canEdit = true;
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnMount: false, gcTime: Infinity },
      },
    });
    client.setQueryData(['coin-flip-settings'], saved);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(CoinFlipsPage),
        ),
      );
    });
    await edit('win_percent', '47.125');
    await edit('reason', 'Operator draft');
  }
  async function refetch() {
    await act(async () => {
      await client.refetchQueries({ queryKey: ['coin-flip-settings'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('retains a dirty draft across a newer background revision until explicit reload', async () => {
    api.read.mockResolvedValue({ ...saved, win_percent: 55, revision: 3 });
    await mount();
    expect(button('Save').disabled).toBe(false);
    await refetch();
    expect(field('win_percent').value).toBe('47.125');
    expect(field('reason').value).toBe('Operator draft');
    expect(host.textContent).toContain('Another admin changed these settings');
    expect(button('Save').disabled).toBe(true);
    await act(async () => {
      button('Discard draft & reload').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(field('win_percent').value).toBe('55');
    expect(field('reason').value).toBe('');
    expect(host.textContent).toContain('revision 3');
  });

  it('keeps the cached editor after a refetch error and resets it after a successful save', async () => {
    api.read.mockRejectedValue(new Error('Connection lost'));
    api.save.mockResolvedValue({ ...saved, win_percent: 47.125, revision: 3 });
    await mount();
    await refetch();
    expect(field('win_percent').value).toBe('47.125');
    expect(field('reason').value).toBe('Operator draft');
    expect(host.textContent).not.toContain(
      'Could not load coin flip settings.',
    );
    await act(async () => {
      button('Save').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.save).toHaveBeenCalledExactlyOnceWith(
      {
        enabled: true,
        win_percent: 47.125,
        win_percent_2: null,
        win_percent_3: null,
        published_win_percent: 50,
        expected_revision: 2,
        reason: 'Operator draft',
      },
      expect.anything(),
    );
    expect(field('win_percent').value).toBe('47.125');
    expect(field('reason').value).toBe('');
    expect(host.textContent).toContain('revision 3');
    expect(button('Save').disabled).toBe(true);
  });
});
