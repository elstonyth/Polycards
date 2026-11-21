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
 * Where the pack's own address (`/slots/<slug>`) opens under the switch: the
 * flow page focused on that pack, its other query kept (each key given once;
 * `focus` is ours). Null when the address carries a `count` (the pack page's
 * own links always do, so those keep the pack page).
 */
export function packFlowAddress(
  slug: string,
  query: URLSearchParams,
): string | null {
  if (query.has('count')) return null;
  const q = new URLSearchParams();
  for (const k of new Set(query.keys()))
    if (k !== 'focus' && query.getAll(k).length === 1)
      q.set(k, query.get(k) ?? '');
  q.set('focus', slug);
  return `/home-preview?${q.toString()}`;
}
