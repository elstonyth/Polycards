import { useEffect, useRef, type RefObject } from 'react';

// Tabbable-element selector used by the focus trap (same list AuthModal used).
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open-modal stack: the TOPMOST panel owns Escape. Stacked dialogs (e.g.
// CardDetailOverlay at z-[100] over PoolModal at z-50) each register their own
// document keydown listener; without this gate one Escape press fires every
// onClose in the same event, collapsing the whole stack.
const modalStack: HTMLElement[] = [];

// Body scroll lock is reference-counted at module level so stacked modals can
// close in ANY order: the first open captures the pre-modal overflow, the last
// close restores it. Per-modal prevOverflow capture depended on strict LIFO —
// a bottom dialog closing under a still-open top overlay restored scrolling
// early, and the overlay's later cleanup then stranded body{overflow:hidden}.
let scrollLockCount = 0;
let preLockOverflow = '';

// Exported for useChromeInert — every body-scroll lock in the app must go
// through this refcount.
export function lockBodyScroll(): void {
  if (scrollLockCount++ === 0) {
    preLockOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
}

export function unlockBodyScroll(): void {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) document.body.style.overflow = preLockOverflow;
}

/**
 * Shared modal accessibility contract, extracted from AuthModal/SellConfirmModal
 * so dialogs stop hand-rolling (and, as RequestDeliveryModal/OddsSheet did,
 * forgetting) it. While `open`, it: moves focus into the panel, traps Tab/
 * Shift+Tab within it (WCAG 2.1.2), closes on Escape, locks body scroll, and
 * restores focus to the triggering element on close (WCAG 2.4.3).
 *
 * For prop-controlled dialogs — pass the panel ref, the `open` flag, and
 * `onClose`. Give the panel `tabIndex={-1}` so it can receive programmatic focus.
 * `onClose` is read through a ref, so the effect re-runs only when `open` flips
 * (a parent passing an inline callback won't re-trigger focus on every render).
 */
export function useModalA11y(
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  // Keep the ref current without re-triggering the focus effect below (writing a
  // ref during render is disallowed in React 19, so do it in its own effect).
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    // Remember whatever had focus (the trigger) so it can be restored on close.
    const trigger = document.activeElement as HTMLElement | null;
    panel?.focus();
    if (panel) modalStack.push(panel);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A panel that isn't topmost ignores Escape — the overlay above it
        // handles this press; the next press reaches this panel.
        if (panel && modalStack[modalStack.length - 1] !== panel) return;
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const f = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (f.length === 0) return;
      // length === 0 is checked above; both indices are in bounds
      const first = f[0]!;
      const last = f[f.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    lockBodyScroll();
    return () => {
      if (panel) {
        const i = modalStack.lastIndexOf(panel);
        if (i !== -1) modalStack.splice(i, 1);
      }
      document.removeEventListener('keydown', onKey);
      unlockBodyScroll();
      trigger?.focus();
    };
  }, [open, panelRef]);
}
