import type { Breadcrumb } from '@sentry/nextjs';

const pathOnly = (url: unknown): unknown =>
  typeof url === 'string' ? url.split(/[?#]/, 1)[0] : url;

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
    for (const key of [
      'http.query',
      'http.fragment',
      'url.query',
      'url.fragment',
    ])
      delete scrubbed[key];
    return { ...breadcrumb, data: scrubbed };
  }
  return breadcrumb;
}
