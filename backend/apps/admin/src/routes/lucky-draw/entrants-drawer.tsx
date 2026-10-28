import { Link } from 'react-router-dom';
import { Badge, Drawer, Table, Text } from '@medusajs/ui';
import { useLuckyDrawEntries, type AdminLuckyDrawPrize } from '../../lib/queries';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

/** Who entered one prize, most tickets first. The API returns customer ids
 *  only, so each row links to the player page for the name. */
export const EntrantsDrawer = ({
  prize,
  onClose,
}: {
  prize: AdminLuckyDrawPrize;
  onClose: () => void;
}) => {
  const { data, isLoading, isError } = useLuckyDrawEntries(prize.id);
  const total = (data ?? []).reduce((n, e) => n + e.tickets, 0);
  const winnerId = prize.result?.winner_customer_id ?? null;

  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>Entrants — {prize.title}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="overflow-y-auto p-0">
          {isError ? (
            <Text size="small" className="text-ui-fg-error p-6">
              Failed to load entrants.
            </Text>
          ) : isLoading || !data ? (
            <div className="p-6">
              <LoadingSkeleton rows={4} />
            </div>
          ) : data.length === 0 ? (
            <Text size="small" className="text-ui-fg-muted p-6">
              Nobody has entered this prize.
            </Text>
          ) : (
            <>
              <Text size="small" className="text-ui-fg-subtle px-6 py-3">
                {data.length} {data.length === 1 ? 'entrant' : 'entrants'} ·{' '}
                {total.toLocaleString()} tickets
                {prize.cancelled_at ? ' (refunded when the prize was cancelled)' : ''}
              </Text>
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Player</Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      Tickets
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      Chance
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.map((e) => (
                    <Table.Row key={e.customer_id}>
                      <Table.Cell>
                        <div className="flex items-center gap-x-2">
                          <Link
                            to={`/customers/${e.customer_id}`}
                            className="text-ui-fg-interactive break-all hover:underline"
                          >
                            {e.customer_id}
                          </Link>
                          {e.customer_id === winnerId && (
                            <Badge size="2xsmall" color="green">
                              Winner
                            </Badge>
                          )}
                        </div>
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums">
                        {e.tickets.toLocaleString()}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                        {total > 0
                          ? `${((e.tickets / total) * 100).toFixed(1)}%`
                          : '—'}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </>
          )}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer>
  );
};
