import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Container, Heading, Input, Table, Text } from '@medusajs/ui';
import { useLuckyDrawTickets } from '../../lib/queries';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { whenLabel } from './lucky-draw-draft';

/** Support lookup: a customer id in, their ticket balance and newest ledger
 *  rows out. Tickets only ever come from task claims, capsules, gifts and
 *  refunds, so the history reads as a statement. */
export const TicketLookup = () => {
  const [input, setInput] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch } =
    useLuckyDrawTickets(customerId);

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Customer tickets</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          A player’s ticket balance and history, for support. Paste the
          customer id (cus_…) from their player page.
        </Text>
        <form
          className="mt-3 flex items-center gap-x-2"
          onSubmit={(e) => {
            e.preventDefault();
            const id = input.trim();
            // The same id again is a "check once more", not a no-op.
            if (id !== '' && id === customerId) void refetch();
            setCustomerId(id === '' ? null : id);
          }}
        >
          <Input
            aria-label="Customer id"
            className="w-80"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="cus_01…"
          />
          <Button
            size="small"
            variant="secondary"
            type="submit"
            disabled={input.trim() === ''}
          >
            Look up
          </Button>
        </form>
      </div>

      {customerId === null ? null : isError ? (
        <Text size="small" className="text-ui-fg-error px-6 pb-6">
          {error instanceof Error ? error.message : 'Lookup failed.'}
        </Text>
      ) : isLoading || !data ? (
        <div className="px-6 pb-6">
          <LoadingSkeleton rows={3} />
        </div>
      ) : (
        <>
          <div className="border-ui-border-base flex flex-wrap items-center gap-x-6 gap-y-1 border-t px-6 py-3">
            <Text weight="plus" className="tabular-nums">
              {data.balance.toLocaleString()}{' '}
              {data.balance === 1 ? 'ticket' : 'tickets'}
            </Text>
            <Link
              to={`/customers/${customerId}`}
              className="text-ui-fg-interactive text-sm break-all hover:underline"
            >
              {customerId}
            </Link>
          </div>
          {data.rows.length === 0 ? (
            <Text size="small" className="text-ui-fg-muted px-6 pb-4">
              No ticket history for this id.
            </Text>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>When</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Change
                  </Table.HeaderCell>
                  <Table.HeaderCell>Reason</Table.HeaderCell>
                  <Table.HeaderCell>Reference</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.rows.map((r, i) => (
                  <Table.Row key={`${r.created_at}-${r.ref}-${i}`}>
                    <Table.Cell className="whitespace-nowrap">
                      {whenLabel(r.created_at)}
                    </Table.Cell>
                    <Table.Cell
                      className={`text-right tabular-nums ${
                        r.delta < 0 ? 'text-ui-fg-subtle' : ''
                      }`}
                    >
                      {r.delta > 0 ? '+' : ''}
                      {r.delta.toLocaleString()}
                    </Table.Cell>
                    <Table.Cell>
                      {r.reason === 'pack_spin' ? 'Capsule' : r.reason}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-muted break-all">
                      {r.ref}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
          {data.rows.length >= 200 && (
            <Text size="small" className="text-ui-fg-muted px-6 py-3">
              Showing the newest 200 rows.
            </Text>
          )}
        </>
      )}
    </Container>
  );
};
