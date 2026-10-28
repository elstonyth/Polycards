import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import CoinFlipsPage, { config, handle } from './page';

const permissions = vi.hoisted(() => ({ canEdit: false }));
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
    max_stake_amount: 100,
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
    expect(html.match(/<input\b[^>]*disabled=""/g)).toHaveLength(6);
    expect(html).not.toContain('id="coin-reason"');
    expect(html).not.toMatch(/<button\b[^>]*>Save<\/button>/);
  });

  it('keeps the audit reason and editing controls for coin operators', () => {
    const html = render(true);
    expect(html).toContain('id="coin-reason"');
    expect(html).not.toMatch(/<input\b[^>]*disabled=""/);
  });
});
