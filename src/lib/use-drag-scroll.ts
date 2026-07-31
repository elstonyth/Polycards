'use client';

import { useRef, type MouseEvent, type PointerEvent } from 'react';

/**
 * Mouse drag-to-scroll for horizontal rails. Touch/pen already swipe natively
 * (overflow-x-auto), so the handlers act on `pointerType === 'mouse'` only —
 * hijacking touch would kill the browser's momentum scrolling.
 *
 * Spread the returned props onto the scroll container (and add
 * `cursor-grab active:cursor-grabbing` to its className). Pointer capture is
 * taken only once movement passes the drag threshold, so plain clicks reach
 * the cards untouched; after a real drag, the click that fires on release is
 * swallowed in the capture phase so a swipe never opens a card.
 */
export function useDragScroll<T extends HTMLElement>() {
  const el = useRef<T | null>(null);
  const state = useRef({
    down: false,
    startX: 0,
    startLeft: 0,
    dragged: false,
  });

  return {
    ref: el,
    onPointerDown: (e: PointerEvent<T>) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || !el.current) return;
      state.current = {
        down: true,
        startX: e.clientX,
        startLeft: el.current.scrollLeft,
        dragged: false,
      };
    },
    onPointerMove: (e: PointerEvent<T>) => {
      const s = state.current;
      if (!s.down || e.pointerType !== 'mouse' || !el.current) return;
      const dx = e.clientX - s.startX;
      if (s.dragged || Math.abs(dx) > 4) {
        s.dragged = true;
        el.current.setPointerCapture(e.pointerId);
        el.current.scrollLeft = s.startLeft - dx;
      }
    },
    onPointerUp: () => {
      state.current.down = false;
    },
    onClickCapture: (e: MouseEvent<T>) => {
      // `dragged` resets on the next pointerdown, so a drag that ends without
      // a click (released off-element) can't swallow a later real click.
      if (state.current.dragged) {
        e.preventDefault();
        e.stopPropagation();
        state.current.dragged = false;
      }
    },
    // The slabs are <img>s; without this a mouse drag starts a native HTML5
    // image drag instead of scrolling.
    onDragStart: (e: MouseEvent<T>) => e.preventDefault(),
  };
}
