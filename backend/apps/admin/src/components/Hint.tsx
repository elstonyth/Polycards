import { Tooltip } from '@medusajs/ui';
import { InformationCircleSolid } from '@medusajs/icons';

/**
 * An ⓘ that holds the explanation a page used to print under every title.
 * Focusable, so the text is reachable by keyboard too, and named for screen
 * readers by the text itself.
 */
export const Hint = ({ text }: { text: string }) => (
  <Tooltip content={text} maxWidth={320}>
    <span
      tabIndex={0}
      role="img"
      aria-label={text}
      className="text-ui-fg-muted hover:text-ui-fg-subtle inline-flex cursor-help align-middle"
    >
      <InformationCircleSolid />
    </span>
  </Tooltip>
);
