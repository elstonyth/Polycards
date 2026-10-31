import { useTranslation } from 'react-i18next';
import type { UseQueryResult } from '@tanstack/react-query';
import { Badge, Container, Heading, Table, Text } from '@medusajs/ui';
import type { CustomerAudit } from '../../../lib/admin-rest';
import { orderDateTime, rm } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';
import { TableState, When } from './bits';

// A credit change's balance before and after, when the row recorded one.
const balanceChange = (before: unknown, after: unknown): string | null => {
  const from = (before as { balance?: unknown } | null)?.balance;
  const to = (after as { balance?: unknown } | null)?.balance;
  return typeof from === 'number' && typeof to === 'number'
    ? `${rm(from)} → ${rm(to)}`
    : null;
};

export const HistoryTab = ({
  auditQ,
  auditPage,
  setAuditPage,
}: {
  auditQ: UseQueryResult<CustomerAudit>;
  auditPage: number;
  setAuditPage: (page: number) => void;
}) => {
  const { t } = useTranslation();

  const { data: auditData, isError: auditError } = auditQ;
  // Ticket grants are audited as a customer `edit`; `after` holds the change.
  const ticketLabel = (after: unknown) => {
    const a = after as { delta?: unknown; lucky_draw_tickets?: unknown } | null;
    return typeof a?.delta === 'number' &&
      typeof a.lucky_draw_tickets === 'number'
      ? t('customer360.action.luckyDrawTickets', {
          delta: `${a.delta > 0 ? '+' : ''}${a.delta.toLocaleString('en-US')}`,
          balance: a.lucky_draw_tickets.toLocaleString('en-US'),
        })
      : null;
  };

  const auditActions = (auditData?.actions ?? [])
    // ponytail: belt-and-suspenders — backend already orders DESC; sort client-side to guarantee newest-first regardless of fetch order
    .slice()
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  const accountState = auditData?.account_state ?? null;

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('customer360.auditTitle')}</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          {t('customer360.auditSubtitle')}
        </Text>
      </div>

      {/* Account state panel */}
      {accountState && (
        <div className="border-t px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle mb-2">
            {t('customer360.accountStateTitle')}
          </Text>
          <div className="flex flex-wrap items-center gap-3">
            {accountState.frozen && (
              <Badge size="small" color="red">
                {t('customer360.accountStateFrozen')}
              </Badge>
            )}
            {accountState.disabled && (
              <Badge size="small" color="red">
                {t('players.disabled')}
              </Badge>
            )}
            {!accountState.frozen && !accountState.disabled && (
              <Badge size="small" color="green">
                {t('customer360.accountStateActive')}
              </Badge>
            )}
            {accountState.freeze_cause && (
              <Text size="small" className="text-ui-fg-subtle">
                {t('customer360.accountStateCause')}:{' '}
                {accountState.freeze_cause}
              </Text>
            )}
            {accountState.frozen_at && (
              <Text size="small" className="text-ui-fg-subtle">
                {t('customer360.accountStateSince', {
                  date: orderDateTime(accountState.frozen_at),
                })}
              </Text>
            )}
          </div>
          {accountState.freeze_reason && (
            <Text size="small" className="text-ui-fg-subtle mt-1">
              &ldquo;{accountState.freeze_reason}&rdquo;
            </Text>
          )}
          {accountState.disabled && accountState.disabled_at && (
            <Text size="small" className="text-ui-fg-subtle mt-1">
              {t('customer360.accountStateSince', {
                date: orderDateTime(accountState.disabled_at),
              })}
              {accountState.disabled_by &&
                ` · ${t('customer360.accountStateBy', { admin: accountState.disabled_by })}`}
            </Text>
          )}
          {accountState.disabled && accountState.disabled_reason && (
            <Text size="small" className="text-ui-fg-subtle mt-1">
              &ldquo;{accountState.disabled_reason}&rdquo;
            </Text>
          )}
        </div>
      )}

      {auditError ? (
        <TableState isError />
      ) : !auditData ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
        </div>
      ) : auditActions.length === 0 ? (
        <TableState empty={t('customer360.auditEmpty')} />
      ) : (
        <>
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label={t('customer360.auditTitle')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>
                    {t('customer360.auditWhen')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.auditAction')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>{t('playerDetail.by')}</Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.auditReason')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {auditActions.map((row) => {
                  const change = balanceChange(row.before, row.after);
                  return (
                    <Table.Row key={row.id}>
                      <Table.Cell className="whitespace-nowrap">
                        <When iso={row.created_at} />
                      </Table.Cell>
                      <Table.Cell>
                        {/* ponytail: t() falls back to raw action key if label missing */}
                        {ticketLabel(row.after) ??
                          t(`customer360.action.${row.action}`, row.action)}
                        {change && (
                          <div className="text-ui-fg-subtle txt-compact-xsmall tabular-nums">
                            {change}
                          </div>
                        )}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                        {row.admin_email ?? row.admin_id}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle">
                        {row.reason ?? '—'}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
          <Pager
            page={auditPage}
            onPage={setAuditPage}
            pageSize={50}
            count={auditActions.length}
            total={null}
          />
        </>
      )}
    </Container>
  );
};
