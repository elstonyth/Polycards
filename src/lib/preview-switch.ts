/**
 * The home preview's switch, and where it sends a pack's own address. Pure and
 * server-safe: the pack route and the proxy read it, so it lives outside the
 * preview's own folders.
 */

/** The preview switch: on in development or with HOME_PREVIEW=1. */
export function homePreviewOn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NODE_ENV === 'development' || env.HOME_PREVIEW === '1';
}

/**
 * Whether a pack's own address opens the flow: only with HOME_PREVIEW=1, so
 * development alone keeps the pack page (the preview page itself stays
 * available there).
 */
export function packFlowOn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.HOME_PREVIEW === '1';
}

/** The preview page's QA query, read only there. */
const QA_SWITCHES = new Set(['soldout', 'jp', 'debug', 'stage', 'loader']);

/**
 * Where the pack's own address (`/slots/<slug>`) opens under the switch: the
 * flow page focused on that pack, its other query kept (each key given once;
 * `focus` is ours; the preview's QA switches never ride on a public link).
 * Null when the address carries a `count` (the pack page's own links always
 * do, so those keep the pack page).
 */
export function packFlowAddress(
  slug: string,
  query: URLSearchParams,
): string | null {
  if (query.has('count')) return null;
  const q = new URLSearchParams();
  for (const k of new Set(query.keys()))
    if (k !== 'focus' && !QA_SWITCHES.has(k) && query.getAll(k).length === 1)
      q.set(k, query.get(k) ?? '');
  q.set('focus', slug);
  return `/home-preview?${q.toString()}`;
}
