import { useEffect, type ReactNode } from "react";
import { Button, StatusBadge, Text } from "@medusajs/ui";

export interface StickySaveBarProps {
  /** Buffer differs from the last saved snapshot. */
  dirty: boolean;
  /** Mutation in flight. */
  saving?: boolean;
  /**
   * Extra gate on top of `dirty` (validation passed, audit reason filled, ...).
   * Defaults to true; `dirty` alone already gates the button.
   */
  canSave?: boolean;
  onSave: () => void;
  /** Renders a Discard button when provided. */
  onDiscard?: () => void;
  /** Save button label. */
  label?: string;
  /** Blocking reason shown next to the status, e.g. a validation summary. */
  message?: ReactNode;
  /** Inline fields that belong to the save action (audit reason input, ...). */
  children?: ReactNode;
}

/**
 * Bottom-pinned save affordance for pages that are hundreds of rows tall, so
 * the operator never has to scroll to the end to commit. Sticks to the bottom
 * of the scroll container; put it as the last child of the route's root element.
 */
export const StickySaveBar = ({
  dirty,
  saving = false,
  canSave = true,
  onSave,
  onDiscard,
  label = "Save",
  message,
  children,
}: StickySaveBarProps) => {
  const enabled = dirty && canSave && !saving;

  // Ctrl/Cmd+S saves without hunting for the button.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (enabled) onSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onSave]);

  return (
    <div className="border-ui-border-base bg-ui-bg-base sticky bottom-0 z-10 flex flex-wrap items-end gap-x-3 gap-y-2 border-t px-4 py-3 shadow-elevation-flyout">
      <div className="flex items-center gap-x-2 self-center" aria-live="polite">
        <StatusBadge color={dirty ? "orange" : "grey"}>
          {dirty ? "Unsaved changes" : "Saved"}
        </StatusBadge>
        {message && (
          <Text size="small" className="text-ui-fg-subtle">
            {message}
          </Text>
        )}
      </div>
      {children}
      <div className="ml-auto flex items-center gap-x-2">
        {onDiscard && (
          <Button
            variant="secondary"
            onClick={onDiscard}
            disabled={!dirty || saving}
          >
            Discard
          </Button>
        )}
        <Button
          variant="primary"
          onClick={onSave}
          isLoading={saving}
          disabled={!enabled}
        >
          {label}
        </Button>
      </div>
    </div>
  );
};

export default StickySaveBar;
