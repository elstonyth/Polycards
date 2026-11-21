/**
 * Where a document load onto a pack's own address opens the home flow, and
 * the preview switch that allows it. Pure and server-safe.
 */

/** The flow's start on a pack: its tab, and its place in that tab's row. */
export type FlowStart = { category: string; index: number };

/**
 * The preview switch (the same one that serves /home-preview): on in
 * development or with HOME_PREVIEW=1.
 */
export function homePreviewOn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NODE_ENV === 'development' || env.HOME_PREVIEW === '1';
}

/**
 * The start for pack `id`: the tab holding it (one that can be picked) and
 * its index in that tab's full row. Null when the pack is not in the
 * catalogue, sits in a tab that cannot be picked, or has no starting data
 * for its focused view; the pack page shows then.
 */
export function flowStart(o: {
  categories: readonly { id: string; packs: readonly { id: string }[] }[];
  tabs: readonly { id: string; soon: boolean }[];
  seeds: Readonly<Record<string, unknown>>;
  id: string;
}): FlowStart | null {
  if (!(o.id in o.seeds)) return null;
  for (const c of o.categories) {
    const index = c.packs.findIndex((p) => p.id === o.id);
    if (index < 0) continue;
    const tab = o.tabs.find((t) => t.id === c.id);
    return tab && !tab.soon ? { category: c.id, index } : null;
  }
  return null;
}
