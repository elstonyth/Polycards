import { useState } from 'react';
import { Input, Label, Prompt, Text } from '@medusajs/ui';

/**
 * A confirm dialog that also asks for the audit reason every Lucky Draw write
 * needs (publish, cancel, withdraw). Mount it only while it is wanted: the reason is
 * local state, so a fresh mount is a blank box — no reset effect.
 *
 * The action does not close the dialog itself (`preventDefault` below): on a
 * refused write the operator keeps the reason they typed and the error toast
 * says why. The caller closes it on success.
 */
export const ReasonPrompt = ({
  title,
  description,
  confirmLabel,
  danger,
  pending,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) => {
  const [reason, setReason] = useState('');
  return (
    <Prompt
      open
      variant={danger ? 'danger' : 'confirmation'}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Prompt.Content>
        <Prompt.Header>
          <Prompt.Title>{title}</Prompt.Title>
          <Prompt.Description>{description}</Prompt.Description>
        </Prompt.Header>
        <div className="flex flex-col gap-y-1 px-6 pb-4">
          <Label htmlFor="ld-reason" size="small" weight="plus">
            Reason
          </Label>
          <Input
            id="ld-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Prizes are ready"
          />
          <Text size="small" className="text-ui-fg-subtle">
            Recorded against your admin account. Required.
          </Text>
        </div>
        <Prompt.Footer>
          <Prompt.Cancel disabled={pending}>Cancel</Prompt.Cancel>
          <Prompt.Action
            disabled={pending || reason.trim() === ''}
            onClick={(e) => {
              e.preventDefault();
              onConfirm(reason.trim());
            }}
          >
            {confirmLabel}
          </Prompt.Action>
        </Prompt.Footer>
      </Prompt.Content>
    </Prompt>
  );
};
