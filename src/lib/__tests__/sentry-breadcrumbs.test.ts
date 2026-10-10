import { describe, expect, it, vi } from 'vitest';
import { scrubBreadcrumbUrls, scrubSpanUrls } from '../sentry-breadcrumbs';
import { sentryDataCollection } from '../sentry-data-collection';

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

  // @sentry/node 11 files them under the OTel url.* names instead.
  it('drops the url.query and url.fragment of the 11.x server shape', () => {
    expect(
      scrubBreadcrumbUrls({
        category: 'http',
        data: {
          url: 'http://backend/auth/customer/google/callback',
          'http.request.method': 'GET',
          'url.query': 'code=c0de&state=s',
          'url.fragment': 'x',
          status_code: 200,
        },
      }),
    ).toEqual({
      category: 'http',
      data: {
        url: 'http://backend/auth/customer/google/callback',
        'http.request.method': 'GET',
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

// Spans carry the same URLs. Next's own request span files the raw URL,
// query string included, under http.target, and the SDK's
// dataCollection.urlQueryParams switch never sees it (measured 2026-10-10
// against a local envelope sink: ?token= and ?code= values arrived intact).
describe('scrubSpanUrls', () => {
  const span = (attributes: Record<string, unknown>, name = 'GET /x') =>
    ({
      name,
      attributes,
      span_id: 's',
      trace_id: 't',
      start_timestamp: 0,
      end_timestamp: 1,
      status: 'ok',
      is_segment: true,
    }) as unknown as Parameters<typeof scrubSpanUrls>[0];

  it("drops the query from Next's http.target and from full URLs", () => {
    const out = scrubSpanUrls(
      span({
        'next.span_type': 'BaseServer.handleRequest',
        'http.method': 'GET',
        'http.target': '/reset-password?token=t0k&email=a%40b.c',
        'http.url': 'https://polycards.gg/auth/google/callback?code=c0de',
        'url.full': 'http://backend/store/x?state=s#frag',
        'url.query': 'code=c0de',
        'url.fragment': 'frag',
        'http.query': '?code=c0de',
        'http.status_code': 200,
      }),
    );
    expect(out.attributes).toEqual({
      'next.span_type': 'BaseServer.handleRequest',
      'http.method': 'GET',
      'http.target': '/reset-password',
      'http.url': 'https://polycards.gg/auth/google/callback',
      'url.full': 'http://backend/store/x',
      'http.status_code': 200,
    });
  });

  it('drops a query that made it into the span name', () => {
    expect(scrubSpanUrls(span({}, 'GET /reset-password?token=t0k')).name).toBe(
      'GET /reset-password',
    );
  });

  it('leaves a span without URLs alone', () => {
    const s = span({ 'next.span_type': 'Layout' }, 'Layout');
    expect(scrubSpanUrls(s)).toEqual(s);
  });
});

// Each runtime's Sentry.init must carry the scrubbers and the data-collection
// switches, or one runtime leaks.
describe.each([
  ['browser', () => import('../../../instrumentation-client')],
  ['server', () => import('../../../sentry.server.config')],
  ['edge', () => import('../../../sentry.edge.config')],
])('the %s Sentry config', (_runtime, load) => {
  it('scrubs breadcrumb and span URLs and keeps personal data off', async () => {
    vi.resetModules();
    const init = vi.fn();
    vi.doMock('@sentry/nextjs', () => ({
      init,
      captureRouterTransitionStart: vi.fn(),
    }));
    await load();
    const [{ beforeBreadcrumb, beforeSendSpan, dataCollection }] =
      init.mock.calls[0]!;
    expect(dataCollection).toEqual(sentryDataCollection);
    expect(
      beforeSendSpan({
        name: 'GET /reset-password',
        attributes: { 'http.target': '/reset-password?token=t0k' },
      }).attributes,
    ).toEqual({ 'http.target': '/reset-password' });
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
