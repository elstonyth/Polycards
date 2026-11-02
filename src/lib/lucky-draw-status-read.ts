import { loadSchemas } from '@/lib/lazy-schemas';

// The Draw tab's dot and the draw popup both want the status on every page load.
// One request between them: chrome fan-out like this is what hit the store-read
// ceiling on 2026-07-07.
const FRESH_MS = 15_000;

export type LuckyDrawChromeStatus = {
  latest_gate_at: string | null;
  upcoming: { id: string; ends_at: string }[];
};

let held: { at: number; read: Promise<LuckyDrawChromeStatus | null> } | null =
  null;

/** The status, shared if read in the last few seconds. Null on any failure: the
 *  dot keeps what it knew, and the popup has nothing new to watch. */
export function readLuckyDrawStatus(): Promise<LuckyDrawChromeStatus | null> {
  const now = Date.now();
  if (held && now - held.at < FRESH_MS) return held.read;
  const read = fetch('/api/lucky-draw-status')
    .then((r) => (r.ok ? r.json() : null))
    // Only when there is a status to read: zod stays off pages with no live draw.
    .then(async (body: unknown) => {
      if (body == null) return null;
      const { LuckyDrawChromeStatusSchema, parseOne } = await loadSchemas();
      return parseOne(LuckyDrawChromeStatusSchema, body);
    })
    .catch(() => null);
  held = { at: now, read };
  return read;
}
