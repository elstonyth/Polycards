import type * as Sentry from '@sentry/nextjs';
import type { Breadcrumb } from '@sentry/nextjs';

type StreamedSpan = Parameters<
  NonNullable<NonNullable<Parameters<typeof Sentry.init>[0]>['beforeSendSpan']>
>[0];

const pathOnly = (url: unknown): unknown =>
  typeof url === 'string' ? url.split(/[?#]/, 1)[0] : url;

/** Attributes that hold a URL whose path is worth keeping. */
const URL_ATTRIBUTES = ['http.target', 'http.url', 'url.full'];
/** Attributes that hold nothing but a query string or fragment. */
const QUERY_ATTRIBUTES = [
  'http.query',
  'http.fragment',
  'url.query',
  'url.fragment',
];

/**
 * Sentry `beforeBreadcrumb` for every runtime (browser, server, edge): strips
 * the query string and fragment from navigation and request breadcrumbs.
 *
 * Breadcrumbs record every navigation and request URL and travel with each
 * error report. An emailed reset link carries its single-use token in the
 * query string, and the Google return leg its code and state; none of that
 * belongs in an error tracker. The path is kept, which is what makes a
 * breadcrumb useful.
 *
 * Shapes: browser `navigation` has `from`/`to`; browser and edge
 * `fetch`/`xhr` have the full `url`; the server's `http` already strips `url`
 * and files the rest beside it, under `http.query` / `http.fragment` on
 * @sentry/* 10.x and `url.query` / `url.fragment` on 11.x.
 */
export function scrubBreadcrumbUrls(breadcrumb: Breadcrumb): Breadcrumb {
  const { category, data } = breadcrumb;
  if (!data) return breadcrumb;
  if (category === 'navigation')
    return {
      ...breadcrumb,
      data: { ...data, from: pathOnly(data.from), to: pathOnly(data.to) },
    };
  if (category === 'fetch' || category === 'xhr' || category === 'http') {
    const scrubbed: Record<string, unknown> = {
      ...data,
      url: pathOnly(data.url),
    };
    for (const key of QUERY_ATTRIBUTES) delete scrubbed[key];
    return { ...breadcrumb, data: scrubbed };
  }
  return breadcrumb;
}

/**
 * Sentry `beforeSendSpan` for every runtime: the same scrub for trace spans.
 *
 * Next's own request span (`BaseServer.handleRequest`) carries the raw URL,
 * query string included, in `http.target`, and outgoing-request spans carry
 * `url.full`. `dataCollection.urlQueryParams: false` does not reach either, so
 * without this a reset link's token or a Google `code` lands in Sentry as soon
 * as a DSN is set.
 */
export function scrubSpanUrls(span: StreamedSpan): StreamedSpan {
  const attributes: Record<string, unknown> = { ...span.attributes };
  for (const key of URL_ATTRIBUTES)
    if (key in attributes) attributes[key] = pathOnly(attributes[key]);
  for (const key of QUERY_ATTRIBUTES) delete attributes[key];
  return {
    ...span,
    name: span.name.replace(/[?#]\S*/, ''),
    attributes: attributes as StreamedSpan['attributes'],
  };
}
