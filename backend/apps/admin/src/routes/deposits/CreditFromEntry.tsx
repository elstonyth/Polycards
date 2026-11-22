import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Label, Prompt, Text, Textarea } from '@medusajs/ui';
import type { GatewayDeposit } from '../../lib/admin-rest';
import { useCreditFromEntry } from '../../lib/queries';
import { rm } from '../../lib/format';

/**
 * Deposits' Credit from gateway entry: the button and its prompt for one row.
 * Refusals are likely (wrong reference, amount too far off, gateway busy), so
 * the prompt keeps what was typed and shows the refusal until the backend says
 * yes, as Link gateway entry does.
 */
export const CreditFromEntry = ({ deposit }: { deposit: GatewayDeposit }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const credit = useCreditFromEntry();
  const ready = ref.trim() !== '' && reason.trim() !== '' && !credit.isPending;

  return (
    <>
      <Button
        size="small"
        variant="secondary"
        onClick={() => {
          setRef('');
          setReason('');
          credit.reset();
          setOpen(true);
        }}
      >
        {t('deposits.creditFromEntry')}
      </Button>
      <Prompt variant="confirmation" open={open} onOpenChange={setOpen}>
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>{t('deposits.entryTitle')}</Prompt.Title>
            <Prompt.Description>{t('deposits.entryDesc')}</Prompt.Description>
          </Prompt.Header>
          <div className="flex flex-col gap-1 px-6 pb-2">
            <Text size="small" className="text-ui-fg-subtle">
              {deposit.gateway_transaction_id ??
                deposit.merchant_transaction_id}
              {' · '}
              {rm(deposit.amount_requested)}
              {deposit.gateway_amount !== null
                ? ` · ${t('deposits.paidIn', {
                    amount: `${deposit.currency} ${deposit.gateway_amount.toFixed(2)}`,
                  })}`
                : null}
            </Text>
            <Label
              htmlFor={`entry-ref-${deposit.id}`}
              size="small"
              className="mt-2"
            >
              {t('deposits.entryRef')}
            </Label>
            <Input
              id={`entry-ref-${deposit.id}`}
              maxLength={64}
              value={ref}
              placeholder="MD20261121150000"
              onChange={(e) => setRef(e.target.value)}
              autoFocus
            />
            <Text size="xsmall" className="text-ui-fg-muted">
              {t('deposits.entryRefHint')}
            </Text>
            <Label
              htmlFor={`entry-reason-${deposit.id}`}
              size="small"
              className="mt-2"
            >
              {t('deposits.entryReason')}
            </Label>
            <Textarea
              id={`entry-reason-${deposit.id}`}
              maxLength={500}
              value={reason}
              placeholder={t('deposits.entryReasonPlaceholder')}
              onChange={(e) => setReason(e.target.value)}
            />
            {credit.error ? (
              <Text size="small" role="alert" className="text-ui-fg-error mt-2">
                {credit.error instanceof Error
                  ? credit.error.message
                  : String(credit.error)}
              </Text>
            ) : null}
          </div>
          <Prompt.Footer>
            <Prompt.Cancel>{t('deposits.entryCancel')}</Prompt.Cancel>
            <Prompt.Action
              disabled={!ready}
              onClick={(e) => {
                // Radix skips its own close when the click is defaultPrevented,
                // so a refusal leaves the prompt open with what was typed.
                e.preventDefault();
                if (!ready) return;
                credit.mutate(
                  { id: deposit.id, ref: ref.trim(), reason: reason.trim() },
                  { onSuccess: () => setOpen(false) },
                );
              }}
            >
              {t('deposits.creditFromEntry')}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </>
  );
};
