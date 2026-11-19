'use client';

/**
 * The open half of the pack sorting (StageChips): the chips, the language
 * toggles, the rules for what a press does, and everything that only matters
 * once the panel opens (focus on the current choice, arrow keys, Escape, a tap
 * outside, tabbing away). Its own chunk, loaded on the first intent to open
 * (or when the page is idle), so the first load carries only the closed tab.
 */
import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import type { StageCategory } from './contract';
import {
  ALL_SHELF,
  languagesOf,
  shelfOf,
  type StageFilter,
} from './stage-filter';

/** A type chip pressed: the language stays only if the new selection still offers it. */
export function withShelf(
  c: Pick<StageCategory, 'shelves'>,
  f: StageFilter,
  key: string,
): StageFilter {
  const shelf = shelfOf(c, key);
  const next = { shelf: shelf?.key ?? ALL_SHELF, language: null };
  const keep =
    f.language !== null &&
    languagesOf(c, next).some((l) => l.key === f.language);
  return keep ? { ...next, language: f.language } : next;
}

/** A language pressed: narrows to it, or clears it when it was already on. */
export function withLanguage(
  c: Pick<StageCategory, 'shelves'>,
  f: StageFilter,
  key: string,
): StageFilter {
  if (f.language === key) return { ...f, language: null };
  if (!languagesOf(c, f).some((l) => l.key === key)) return f;
  return { ...f, language: key };
}

/** Where arrow keys move focus among the panel's buttons (wraps). */
export function nextFocusIndex(
  key: string,
  at: number,
  count: number,
): number | null {
  if (count === 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step =
    key === 'ArrowRight' || key === 'ArrowDown'
      ? 1
      : key === 'ArrowLeft' || key === 'ArrowUp'
        ? -1
        : 0;
  if (step === 0) return null;
  return at < 0 ? 0 : (at + step + count) % count;
}

const RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none';

export default function StageSortPanel({
  open,
  close,
  ready,
  rootRef,
  panelRef,
  category,
  filter,
  onPick,
}: {
  open: boolean;
  /** Closes the panel; `focusTab` gives focus back to the tab. */
  close: (focusTab: boolean) => void;
  /** Called once mounted: the panel may now unroll. */
  ready: () => void;
  rootRef: RefObject<HTMLDivElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  category: Pick<StageCategory, 'shelves'>;
  filter: StageFilter;
  /** The row to show next (StageChips hands it to PackStage). */
  onPick: (next: StageFilter) => void;
}) {
  useLayoutEffect(ready, [ready]);
  const shelves = category.shelves.length > 2 ? category.shelves : [];
  const languages = languagesOf(category, filter);

  // While open: a tap outside, Escape or tabbing away closes it; arrows move focus.
  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const panel = panelRef.current;
    // Opened: focus lands on the current choice.
    (
      panel?.querySelector<HTMLElement>('button[aria-pressed="true"]') ??
      panel?.querySelector<HTMLElement>('button')
    )?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!root || (target && root.contains(target))) return;
      close(root.contains(document.activeElement));
      // A tap on the carousel only closes the panel: it must not also centre
      // or open a pack.
      if (target?.closest('[data-stage-viewport]')) {
        const swallow = (ev: MouseEvent) => {
          ev.preventDefault();
          ev.stopPropagation();
        };
        window.addEventListener('click', swallow, {
          capture: true,
          once: true,
        });
        setTimeout(
          () => window.removeEventListener('click', swallow, { capture: true }),
          600,
        );
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
        return;
      }
      if (!panel?.contains(document.activeElement)) return;
      const buttons = [...panel.querySelectorAll<HTMLElement>('button')];
      const next = nextFocusIndex(
        e.key,
        buttons.indexOf(document.activeElement as HTMLElement),
        buttons.length,
      );
      if (next === null) return;
      e.preventDefault();
      buttons[next]?.focus();
    };
    const onOut = (e: FocusEvent) => {
      const to = e.relatedTarget;
      if (to instanceof Node && !root?.contains(to)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    root?.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      root?.removeEventListener('focusout', onOut);
    };
  }, [open, close, panelRef, rootRef]);

  /** A choice: the panel starts closing, then the row changes. */
  const choose = (next: StageFilter) => {
    close(true);
    requestAnimationFrame(() => onPick(next));
  };

  return (
    <>
      <div className="flex items-stretch justify-center gap-1 border-t border-white/[0.06] pt-1">
        {shelves.map((s) => {
          const on = s.key === filter.shelf;
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={on}
              onClick={() => choose(withShelf(category, filter, s.key))}
              className={cn(
                RING,
                'flex min-h-11 flex-1 flex-col items-center justify-center whitespace-nowrap rounded-full px-2 text-[13px] font-semibold leading-[1.15] transition-colors lg:text-sm',
                on
                  ? 'bg-white/10 text-white'
                  : 'text-neutral-400 hover:text-white',
              )}
            >
              {s.label}
              {s.caption && (
                <span
                  className={cn(
                    'text-[10px] font-medium lg:text-[11px]',
                    on ? 'text-neutral-300' : 'text-neutral-500',
                  )}
                >
                  {s.caption}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {languages.length > 0 && (
        // A two-part segmented pill; pressing the lit one clears it.
        <div
          role="group"
          aria-label="Language"
          className="mx-auto mt-1 flex w-fit gap-1 rounded-full border border-white/10 p-1"
        >
          {languages.map((l) => {
            const on = l.key === filter.language;
            return (
              <button
                key={l.key}
                type="button"
                aria-pressed={on}
                onClick={() => choose(withLanguage(category, filter, l.key))}
                className={cn(
                  RING,
                  'min-h-10 flex-1 rounded-full px-4 text-[13px] font-semibold transition-colors',
                  on
                    ? 'bg-neutral-50 text-neutral-950'
                    : 'text-neutral-400 hover:text-white',
                )}
              >
                {l.label}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
