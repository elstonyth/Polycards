import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Prompt,
  Text,
  Textarea,
  toast,
} from '@medusajs/ui';
import {
  useAdjustTickets,
  useCustomerGacha,
  useLuckyDrawTickets,
} from '../../../lib/queries';
import { parseGroupTickets } from '../../../lib/group-credit-edit';
import { attemptKey, settleAttempt } from './grant-attempts';

const num = (n: number) => n.toLocaleString('en-US');

// Lucky Draw tickets (operator 2026-10-25): give or take back tickets, with
// the same confirm + idempotent-retry pattern as the bonus credit panel. The
// backend refuses a take-back below zero and records the note in the audit.
export const LuckyDrawTicketsPanel = ({
  customerId,
}: {
  customerId: string;
}) => {
  const { t } = useTranslation();
  const { data: view } = useCustomerGacha(customerId);
  const ticketsQ = useLuckyDrawTickets(customerId);
  const adjust = useAdjustTickets();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  // Idempotency slot, kept outside the panel: see grant-attempts.ts.
  const slot = `tickets:${customerId}`;

  const tickets = parseGroupTickets(amount);
  const valid = tickets !== null && !!note.trim();
  const email = view?.customer.email ?? customerId;

  function handleConfirm() {
    setConfirming(false);
    if (tickets === null || !note.trim() || adjust.isPending) return;
    const trimmed = note.trim();
    // The promise, unlike mutate()'s per-call callbacks, still settles after
    // the panel unmounts, so a mid-request tab switch can't strand the slot.
    adjust
      .mutateAsync({
        id: customerId,
        tickets,
        note: trimmed,
        idempotencyKey: attemptKey(
          slot,
          JSON.stringify([customerId, tickets, trimmed]),
        ),
      })
      .then(
        (res) => {
          settleAttempt(slot);
          toast.success(
            t('customer360.tickets.applied', { balance: num(res.balance) }),
          );
          setAmount('');
          setNote('');
          amountRef.current?.focus();
        },
        (e: unknown) => settleAttempt(slot, e),
      );
  }

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('customer360.tickets.title')}</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          {t('customer360.tickets.subtitle')}
        </Text>
      </div>
      <div className="grid grid-cols-1 gap-3 border-t px-6 py-4 lg:grid-cols-[12rem_1fr_1fr_auto] lg:items-end">
        <div>
          <Text size="small" className="text-ui-fg-subtle">
            {t('customer360.tickets.balance')}
          </Text>
          <Text size="xlarge" weight="plus" className="mt-1 tabular-nums">
            {ticketsQ.data ? num(ticketsQ.data.balance) : '—'}
          </Text>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tickets-amount" size="small">
            {t('customer360.tickets.amount')}
          </Label>
          <Input
            ref={amountRef}
            id="tickets-amount"
            type="number"
            step="1"
            aria-invalid={amount.trim() !== '' && tickets === null}
            aria-describedby="tickets-amount-error"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {amount.trim() !== '' && tickets === null && (
            <Text
              id="tickets-amount-error"
              role="alert"
              size="small"
              className="text-ui-fg-error"
            >
              {t('customer360.tickets.invalid')}
            </Text>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tickets-note" size="small">
            {t('customer360.tickets.note')}
          </Label>
          <Textarea
            id="tickets-note"
            rows={1}
            maxLength={512}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button
          size="small"
          onClick={() => setConfirming(true)}
          disabled={!valid}
          isLoading={adjust.isPending}
        >
          {t('customer360.tickets.apply')}
        </Button>
      </div>

      <Prompt
        variant="confirmation"
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
      >
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>
              {t(
                (tickets ?? 0) > 0
                  ? 'customer360.tickets.confirmGive'
                  : 'customer360.tickets.confirmTake',
                { tickets: num(Math.abs(tickets ?? 0)), email },
              )}
            </Prompt.Title>
            <Prompt.Description>
              {t('customer360.tickets.confirmDesc')}
            </Prompt.Description>
          </Prompt.Header>
          <Prompt.Footer>
            <Prompt.Cancel>{t('support.adjustCancel')}</Prompt.Cancel>
            <Prompt.Action onClick={handleConfirm}>
              {t('customer360.tickets.apply')}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </Container>
  );
};
