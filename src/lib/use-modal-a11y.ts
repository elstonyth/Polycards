import { useEffect, useRef, type RefObject } from 'react';

// Tabbable-element selector used by the focus trap (same list AuthModal used).
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      trigger?.focus();
    };
  }, [open, panelRef]);
}
