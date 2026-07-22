import type { ReactNode } from "react";
import { DropdownMenu, IconButton, usePrompt } from "@medusajs/ui";
import { EllipsisHorizontal } from "@medusajs/icons";

export interface RowActionConfirm {
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  /**
   * Type-to-confirm string. Only for genuinely irreversible work (an immediate
   * server-side delete). Staged, in-buffer edits should not carry one.
   */
  verificationText?: string;
}

export interface RowAction {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  /**
   * Destructive tone: quiet at rest, error-coloured on hover/keyboard focus.
   * See `.pc-danger-item` in src/admin-ui.css.
   */
  danger?: boolean;
  /** Present => a modal confirmation gates the action. */
  confirm?: RowActionConfirm;
}

export interface RowActionsProps {
  /**
   * Names the row for screen readers, e.g. 'VIP level 5'. Required: 100 buttons
   * all labelled 'Row actions' are useless in a screen-reader rotor.
   */
  subject: string;
  actions: RowAction[];
}

/**
 * One overflow menu per row instead of a cluster of buttons. Keyboard reachable
 * (a real button plus a Radix menu), never hover-only.
 */
export const RowActions = ({ subject, actions }: RowActionsProps) => {
  const prompt = usePrompt();

  const run = async (action: RowAction) => {
    if (action.confirm) {
      const ok = await prompt({
        variant: "danger",
        title: action.confirm.title,
        description: action.confirm.description,
        confirmText: action.confirm.confirmText ?? action.label,
        cancelText: action.confirm.cancelText ?? "Cancel",
        verificationText: action.confirm.verificationText,
      });
      if (!ok) return;
    }
    action.onSelect();
  };

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger asChild>
        <IconButton
          size="small"
          variant="transparent"
          aria-label={"Actions for " + subject}
        >
          <EllipsisHorizontal />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        {actions.map((action) => (
          <DropdownMenu.Item
            key={action.label}
            disabled={action.disabled}
            className={action.danger ? "pc-danger-item" : undefined}
            onSelect={() => {
              void run(action);
            }}
          >
            {action.icon}
            {action.label}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
};

export default RowActions;
