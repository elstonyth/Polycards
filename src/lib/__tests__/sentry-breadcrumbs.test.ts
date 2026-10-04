import { describe, expect, it, vi } from 'vitest';
import { scrubBreadcrumbUrls } from '../sentry-breadcrumbs';

// Sentry breadcrumbs record every navigation and request URL. An emailed reset
// link carries its single-use token in the query string (and the Google return
// leg its code and state), so the query and fragment go before any breadcrumb
// leaves the process. Paths stay: they are what makes a breadcrumb useful.

describe('scrubBreadcrumbUrls', () => {
  it('drops the query and fragment from both ends of a navigation', () => {
    expect(
      scrubBreadcrumbUrls({
        category: 'navigation',
        data: { from: '/reset-password?token=t0k&email=a', to: '/#top' },
      }),
    ).toEqual({
      category: 'navigation',
      data: { from: '/reset-password', to: '/' },
    });
  });

  it.each(['fetch', 'xhr'])(
    'drops the query from a browser %s URL and keeps the rest',
    (category) => {
      expect(
        scrubBreadcrumbUrls({
          category,
          type: 'http',
          data: {
            method: 'GET',
            url: 'https://polycards.gg/reset-password?token=t0k',
            status_code: 200,
          },
        }),
      ).toEqual({
        category,
        type: 'http',
        data: {
          method: 'GET',
          url: 'https://polycards.gg/reset-password',
          status_code: 200,
        },
      });
    },
  );

  // The server SDK already strips the URL but files the query beside it.
  it('drops the query and fragment the server SDK keeps beside the URL', () => {
    expect(
      scrubBreadcrumbUrls({
        category: 'http',
        data: {
          url: 'http://backend/auth/customer/google/callback',
          'http.method': 'GET',
          'http.query': '?code=c0de&state=s',
          'http.fragment': '#x',
          status_code: 200,
        },
      }),
    ).toEqual({
      category: 'http',
      data: {
        url: 'http://backend/auth/customer/google/callback',
        'http.method': 'GET',
        status_code: 200,
      },
    });
  });

  it('leaves every other breadcrumb untouched', () => {
    const click = {
      category: 'ui.click',
      message: 'button.submit',
      data: { url: 'kept?as=is' },
    };
    expect(scrubBreadcrumbUrls(click)).toBe(click);
    const bare = { category: 'navigation' };
    expect(scrubBreadcrumbUrls(bare)).toBe(bare);
  });
});

// Each runtime's Sentry.init must carry the scrubber, or one runtime leaks.
describe.each([
  ['browser', () => import('../../../instrumentation-client')],
  ['server', () => import('../../../sentry.server.config')],
  ['edge', () => import('../../../sentry.edge.config')],
])('the %s Sentry config', (_runtime, load) => {
  it('scrubs breadcrumb URLs', async () => {
    vi.resetModules();
    const init = vi.fn();
    vi.doMock('@sentry/nextjs', () => ({
      init,
      captureRouterTransitionStart: vi.fn(),
    }));
    await load();
    const [{ beforeBreadcrumb }] = init.mock.calls[0]!;
    expect(
      beforeBreadcrumb({
        category: 'navigation',
        data: { from: '/reset-password?token=t0k', to: '/' },
      }),
    ).toEqual({
      category: 'navigation',
      data: { from: '/reset-password', to: '/' },
    });
    vi.doUnmock('@sentry/nextjs');
  });
});
