'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import type { StageCategory } from './contract';
import { languagesOf, type StageFilter } from './stage-filter';
import styles from './pack-stage.module.css';

type PanelModule = typeof import('./StageSortPanel');
type Panel = PanelModule['default'];

/** One fetch of the panel's chunk at a time; a failed one may be tried again. */
let panelLoad: Promise<Panel> | null = null;
function loadPanel(): Promise<Panel> {
  panelLoad ??= import(
    /* webpackChunkName: "stage-sort-panel" */ './StageSortPanel'
  ).then(
    (m: PanelModule) => m.default,
    (e: unknown) => {
      panelLoad = null; // the next intent tries again
      throw e;
    },
  );
  return panelLoad;
}

/**
 * The stage's pack sorting (owner's pick, 2026-11-20): a tab hangs from the
 * category pill and names the current choice; opened, the pill grows a second
 * level for the active category ("All" first, one chip per pack type with its
 * graded / raw word where true, and the language toggles when the selection
 * carries two or more languages). The panel unrolls over the stage and never
 * moves the layout; it closes on a choice, a tap outside and Escape, and focus
 * goes back to the tab. A choice is applied on the frame after the panel
 * starts closing, so the sink and rise are seen. CSS-only motion, none under
 * reduced motion; the look lives in pack-stage.module.css (.chipRow, .growTab,
 * .growPanel). Every word arrives as server data (stage-packs.ts).
 *
 * Only the closed tab is in the first load: the panel's contents are their own
 * chunk, fetched on the first intent to open (hover, focus, press) or when the
 * page goes idle. Until they arrive the tab stays as it is; if the fetch fails
 * nothing breaks, the panel just does not open, and the next intent retries.
 */
export default function StageChips({
  category,
  filter,
  label,
  off,
  onPick,
}: {
  /** "All" first, then the type shelves (stage-packs.ts). */
  category: Pick<StageCategory, 'shelves'>;
  filter: StageFilter;
  /** The closed tab's text: the current choice (filterLabel). */
  label: string;
  /** The category on show has no choices (Poly): no tab, its room kept. */
  off: boolean;
  onPick: (next: StageFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [SortPanel, setSortPanel] = useState<ComponentType<
    Parameters<Panel>[0]
  > | null>(null);
  const [ready, setReady] = useState(false);
  const isOpen = open && !off;
  const shown = isOpen && ready;
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const want = useCallback(() => {
    loadPanel().then(
      (P) => setSortPanel(() => P),
      () => setOpen(false), // no panel to show: stay closed
    );
  }, []);

  // Fetch the panel when the page is idle, so a first tap rarely waits.
  useEffect(() => {
    // Safari has no requestIdleCallback.
    if ('requestIdleCallback' in window)
      requestIdleCallback(want, { timeout: 4000 });
    else setTimeout(want, 2500);
  }, [want]);

  const close = useCallback((focusTab: boolean) => {
    setOpen(false);
    if (focusTab) tabRef.current?.focus({ preventScroll: true });
  }, []);
  const markReady = useCallback(() => setReady(true), []);

  if (category.shelves.length < 3 && languagesOf(category, filter).length < 2)
    return null;

  return (
    <div
      ref={rootRef}
      data-stage-chips=""
      data-off={off || undefined}
      aria-hidden={off || undefined}
      inert={off || undefined}
      className={styles.chipRow}
    >
      <button
        ref={tabRef}
        type="button"
        aria-expanded={shown}
        aria-controls={panelId}
        data-chosen={
          filter.shelf !== category.shelves[0]?.key ||
          filter.language !== null ||
          undefined
        }
        onPointerEnter={want}
        onFocus={want}
        onPointerDown={want}
        onClick={() => {
          want();
          setOpen((o) => !o);
        }}
        className={styles.growTab}
      >
        <span className="sr-only">Pack type: </span>
        {label}
        <svg aria-hidden viewBox="0 0 24 24">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <div
        ref={panelRef}
        id={panelId}
        role="group"
        aria-label="Pack type"
        // Unrolls only once its contents exist (the first open may wait for them).
        data-open={shown || undefined}
        inert={!shown || undefined}
        className={styles.growPanel}
      >
        {SortPanel && (
          <SortPanel
            open={shown}
            close={close}
            ready={markReady}
            rootRef={rootRef}
            panelRef={panelRef}
            category={category}
            filter={filter}
            onPick={onPick}
          />
        )}
      </div>
    </div>
  );
}
