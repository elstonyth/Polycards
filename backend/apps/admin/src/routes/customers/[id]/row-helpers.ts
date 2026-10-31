import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { SupportPull } from '../../../lib/admin-rest';
import { orderDateTime, timeAgo } from '../../../lib/format';

/** A date on one line, for a detail panel. */
export const whenText = (iso: string | null | undefined): string | null =>
  iso ? `${orderDateTime(iso)} · ${timeAgo(iso)}` : null;

/** Makes a table row open its detail panel, by mouse or keyboard. Dragging
 *  across a row to copy a reference does not open it. */
export const openableRow = (open: () => void) => ({
  className: 'cursor-pointer',
  tabIndex: 0,
  onClick: () => {
    if (!window.getSelection()?.toString()) open();
  },
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  },
});

/** The pack's title, or how they got the card when no pack row exists (a task
 *  reward has a slug, not a pack). A paid pack since deleted keeps its slug, so
 *  support can still name it. */
export const useOrigin = () => {
  const { t } = useTranslation();
  return (p: SupportPull) =>
    p.pack_title ??
    (p.source && p.source !== 'pack'
      ? t(`playerDetail.source.${p.source}`, p.source)
      : p.pack_id);
};

/** For a dialog with no Radix trigger: hands focus back to what opened it on
 *  close, or a keyboard user lands on the page body. */
export const useRestoreFocus = () => {
  const opener = useRef(document.activeElement as HTMLElement | null);
  return (e: Event) => {
    e.preventDefault();
    opener.current?.focus();
  };
};
