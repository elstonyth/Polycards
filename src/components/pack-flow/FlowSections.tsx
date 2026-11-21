import type { ReactNode } from 'react';
import { getRecentPulls } from '@/lib/data/packs';
import { cached } from '@/lib/ttl-cache';
import { FlowFooter } from './FlowFooter';
import { FlowJustPulled } from './FlowJustPulled';
import { FlowSpacers } from './FlowSpacers';

// shortcut: the same memo window and key as src/app/page.tsx's feed read.
// Remove the duplicate when the stage moves onto `/`.
const FEED_TTL_MS = 5_000;

/**
 * What a section can ask the page for, and how the page reads each one
 * (server only). The page reads only what the listed sections need.
 */
const FLOW_DATA = {
  feed: () => cached('home:recent-pulls', FEED_TTL_MS, () => getRecentPulls()),
} satisfies Record<string, () => Promise<unknown>>;

type FlowDataReaders = typeof FLOW_DATA;
export type FlowDataKey = keyof FlowDataReaders;
/** The data the sections read, by key. */
export type FlowData = {
  [K in FlowDataKey]: Awaited<ReturnType<FlowDataReaders[K]>>;
};

/** One section below the lineup. */
export type FlowSection = {
  /** Its `data-flow-section` id: unique, kebab-case. */
  id: string;
  /** The data it reads. */
  needs: readonly FlowDataKey[];
  render(data: Partial<FlowData>): ReactNode;
};

/** A section that reads the data in `needs` (and only that). */
export function flowSection<K extends FlowDataKey>(
  id: string,
  needs: readonly K[],
  render: (data: Pick<FlowData, K>) => ReactNode,
): FlowSection {
  // loadFlowData reads every key a listed section needs, so these are there
  return { id, needs, render: (data) => render(data as Pick<FlowData, K>) };
}

/**
 * The page below the lineup, top to bottom. This list is the one place a
 * section is added, removed or moved:
 *
 * 1. Write its server component in this folder.
 * 2. Add one `flowSection('<id>', [<data it needs>], (data) => <Component />)`
 *    entry here, in page order. New data: add a reader to FLOW_DATA above.
 *
 * Each entry is wrapped in `<div data-flow-section="<id>">`; the stage finds
 * the sections by that attribute and never by name. Keep the footer last:
 * the chosen pack rises with whichever section is last, and it carries the
 * legal links.
 */
export const FLOW_SECTIONS: readonly FlowSection[] = [
  flowSection('just-pulled', ['feed'], ({ feed }) => (
    <FlowJustPulled feed={feed} />
  )),
  flowSection('footer', [], () => <FlowFooter />),
];

/** Reads the data the given sections need, each key once. */
export async function loadFlowData(
  sections: readonly FlowSection[] = FLOW_SECTIONS,
): Promise<Partial<FlowData>> {
  const keys = [...new Set(sections.flatMap((s) => s.needs))];
  const values = await Promise.all(keys.map((k) => FLOW_DATA[k]()));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

/**
 * Everything below the stage on the preview, in the flow's order: the paged
 * spacers, the listed sections (the first rises in as the lineup lifts
 * away), then the Return and Last spacers. Server-rendered: no client code
 * of its own.
 */
export function FlowSections({
  data,
  sections = FLOW_SECTIONS,
}: {
  data: Partial<FlowData>;
  sections?: readonly FlowSection[];
}) {
  return (
    <>
      <FlowSpacers part="paged" />
      {sections.map((s) => (
        <div key={s.id} data-flow-section={s.id}>
          {s.render(data)}
        </div>
      ))}
      <FlowSpacers part="end" />
    </>
  );
}
