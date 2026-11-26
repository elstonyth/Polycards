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
 * The stage's pack sorting, a select (owner, 2026-11-26; it was a tab fused
 * to the category pill): a round filter button at the end of the category
 * bar (PackCategoryTabs), with a dot once a choice is made; opened, a list
 * drops under the bar for the active category ("All" first, one row per pack
 * type with its graded / raw word where true, then the languages when the
 * selection carries two or more), with a tick on the current choice. The
 * button folds out of the bar while its category has no choices (Poly). The
 * list floats over the stage and never moves the layout;
 * it closes on a choice, a tap outside and Escape, and focus goes back to the
 * trigger. A choice is applied on the frame after the list starts closing, so
 * the sink and rise are seen. CSS-only motion, none under reduced motion; the
 * look lives in pack-stage.module.css (.chipRow, .chipClip, .growTab,
 * .growPanel). Every
 * word arrives as server data (stage-packs.ts).
 *
 * Only the trigger is in the first load: the list's contents are their own
 * chunk, fetched on the first intent to open (hover, focus, press) or when the
 * page goes idle. Until they arrive the trigger stays as it is; if the fetch
 * fails nothing breaks, the list just does not open, and the next intent
 * retries.
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
      <div className={styles.chipClip}>
        <span aria-hidden className={styles.chipSep} />
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
          <svg aria-hidden viewBox="0 0 24 24">
            <path d="M3 6h18M7 12h10M10 18h4" />
          </svg>
          <span className="sr-only">Pack type: {label}</span>
        </button>
      </div>

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
