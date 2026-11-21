import { packPagePath } from './stage-focus-marks';
import { FLOW_ENTRY_ATTR } from './stage-loader-script';

/**
 * The cover over a load onto a pack's own address: the pre-paint script marks
 * the document (`html[data-flow-entry=<id>]`), the flow removes the mark once
 * the pack rests on its stop, and the loader lets go only then.
 */

/** The id of the pack this document's load is still placing, else null. */
export function pendingEntry(doc: Document = document): string | null {
  return doc.documentElement.getAttribute(FLOW_ENTRY_ATTR);
}

/** The pack rests on its stop: the loader may let go. */
export function entryPlaced(doc: Document = document): void {
  doc.documentElement.removeAttribute(FLOW_ENTRY_ATTR);
}

let bound = false;

/**
 * Whether this bind of the flow places a focus entry with no move: the
 * document's first bind, or any bind while its load is still being placed
 * under the cover (the stage bound again before the pack rested). A later
 * bind (Back from the reel, the stage mounted again) moves there as usual.
 */
export function placeInstantly(doc: Document = document): boolean {
  const first = !bound;
  bound = true;
  return first || pendingEntry(doc) !== null;
}

/** The pack was not placed in time: today's pack page instead. */
export function goToPackPage(id: string): void {
  window.location.replace(packPagePath(id));
}
