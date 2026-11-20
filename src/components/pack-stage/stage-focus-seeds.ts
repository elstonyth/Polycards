/**
 * The focused pack view's starting data on the page: a JSON block the server
 * renders (one `FlowSeed` per pack id), read by the focus chunk at a tap.
 */
export const FOCUS_SEEDS_ID = 'stage-focus-seeds';

/** The seeds on the page, by pack id (an empty map without the block). */
export function readFocusSeeds<T>(): Record<string, T> {
  try {
    const el = document.getElementById(FOCUS_SEEDS_ID);
    return el?.textContent
      ? (JSON.parse(el.textContent) as Record<string, T>)
      : {};
  } catch {
    return {};
  }
}
