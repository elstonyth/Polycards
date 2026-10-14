import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Container, Heading, Table, Text } from '@medusajs/ui';
import {
  useCustomerMoney,
  useCustomerTransactions,
} from '../../../lib/queries';
import { orderDateTime, rm, timeAgo } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';
import { delta } from '../../economy/signs';
import { StatTile } from './MoneyCards';
import { WALLET_FILTERS, ledgerKind, type WalletFilter } from './ledger-kind';
import { withdrawableNote } from './wallet-note';

const FILTERS = Object.keys(WALLET_FILTERS) as WalletFilter[];

// Dot colour per direction: money in green, out red, bonus purple.
const dot = (kind: string, amount: number) =>
  kind === 'bonusGiven' || kind === 'bonusTaken'
    ? 'bg-ui-tag-purple-icon'
    : amount > 0
      ? 'bg-ui-tag-green-icon'
      : 'bg-ui-tag-red-icon';

/**
 * The wallet as support needs it: what the player holds, what can leave
 * right now and why not (the withdraw button's own gate: frozen, never
 * topped up, bonus, deposits still to play through), then the ledger in
 * words, filterable by kind.
 */
export const WalletTab = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<WalletFilter>('all');
  const [page, setPage] = useState(0);
  const { data: money } = useCustomerMoney(customerId);
  const { data, isError } = useCustomerTransactions(
    customerId,
    page,
    WALLET_FILTERS[filter],
  );
  const rows = data?.items ?? [];
  const w = money?.wallet;
  const note = w ? withdrawableNote(w) : null;
  const pt = w?.playthrough;
  // Share of the deposits already spent on packs, for the bar.
  const ptPct =
    pt && pt.deposited > 0
      ? Math.min(100, Math.max(0, (pt.used / pt.deposited) * 100))
      : 100;

  return (
    <>
      <Container className="p-0">
        <div className="bg-ui-border-base grid grid-cols-1 gap-px sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label={t('playerMoney.balance')}
            value={w ? rm(w.balance) : '—'}
            note={t('playerMoney.balanceNote')}
          />
          <StatTile
            label={t('playerMoney.withdrawableNow')}
            hint={t('playerMoney.withdrawableHint')}
            value={w ? rm(w.withdrawable) : '—'}
            valueClass={w && w.withdrawable > 0 ? 'text-ui-tag-green-text' : ''}
            note={
              note
                ? t(`playerMoney.${note.key}`, {
                    held: 'held' in note ? rm(note.held) : undefined,
                  })
                : undefined
            }
          />
          <StatTile
            label={t('playerMoney.bonusLabel')}
            value={w ? rm(w.bonus) : '—'}
            note={t('playerMoney.bonusNote')}
          />
          <StatTile
            label={t('playerMoney.stillToPlay')}
            hint={t('playerMoney.stillToPlayHint')}
            value={pt ? rm(pt.remaining) : '—'}
            note={
              pt &&
              (pt.remaining > 0 ? (
                <span className="flex flex-col gap-1.5">
                  <span
                    className="bg-ui-bg-component mt-1 block h-1.5 w-full overflow-hidden rounded-full"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(ptPct)}
                    aria-label={t('playerMoney.stillToPlay')}
                  >
                    <span
                      className="bg-ui-fg-interactive block h-full rounded-full"
                      style={{ width: `${ptPct}%` }}
                    />
                  </span>
                  {t('playerMoney.stillToPlayNote', {
                    used: rm(pt.used),
                    deposited: rm(pt.deposited),
                  })}
                </span>
              ) : (
                t('playerMoney.nothingHeld')
              ))
            }
          />
        </div>
      </Container>

      <Container className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <Heading level="h2">{t('playerMoney.historyTitle')}</Heading>
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label={t('playerMoney.historyTitle')}
          >
            {FILTERS.map((f) => (
              <Button
                key={f}
                size="small"
                variant={filter === f ? 'primary' : 'secondary'}
                aria-pressed={filter === f}
                onClick={() => {
                  setFilter(f);
                  setPage(0);
                }}
              >
                {t(`playerMoney.filter.${f}`)}
              </Button>
            ))}
          </div>
        </div>

        {isError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !data ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : rows.length === 0 ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">{t('support.empty')}</Text>
          </div>
        ) : (
          <>
            <div
              className="overflow-x-auto border-t"
              tabIndex={0}
              role="region"
              aria-label={t('playerMoney.historyTitle')}
            >
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{t('support.when')}</Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('playerMoney.colType')}
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t('support.amount')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('playerMoney.colReference')}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {rows.map((tx) => {
                    const kind = ledgerKind(tx.reason, tx.amount);
                    const bonus = tx.bonus ?? 0;
                    return (
                      <Table.Row key={tx.id}>
                        <Table.Cell className="whitespace-nowrap">
                          <div className="tabular-nums">
                            {orderDateTime(tx.created_at)}
                          </div>
                          <div className="text-ui-fg-subtle txt-compact-xsmall">
                            {timeAgo(tx.created_at)}
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="inline-flex items-center gap-2 whitespace-nowrap">
                            <span
                              aria-hidden
                              className={`size-2 shrink-0 rounded-full ${dot(kind, tx.amount)}`}
                            />
                            {kind === 'other'
                              ? tx.reason
                              : t(`playerMoney.kind.${kind}`)}
                          </span>
                        </Table.Cell>
                        <Table.Cell className="whitespace-nowrap text-right">
                          <div
                            className={`txt-compact-small-plus tabular-nums ${tx.amount > 0 ? 'text-ui-tag-green-text' : ''}`}
                          >
                            {delta(tx.amount)}
                          </div>
                          {bonus !== 0 && (
                            <div className="text-ui-fg-subtle txt-compact-xsmall tabular-nums">
                              {t('playerMoney.inclBonus', {
                                amount: rm(Math.abs(bonus)),
                              })}
                            </div>
                          )}
                        </Table.Cell>
                        <Table.Cell className="max-w-[22rem]">
                          {tx.ledger_display_id && (
                            <div className="txt-compact-small-plus font-mono">
                              {tx.ledger_display_id}
                            </div>
                          )}
                          {/* Gateway refs run to 40 characters: cut, whole
                              on hover. A code reads in mono; an admin's note
                              (it has spaces) stays in the text face. */}
                          <div
                            className={`text-ui-fg-subtle txt-compact-xsmall truncate ${tx.reference && !/\s/.test(tx.reference) ? 'font-mono' : ''}`}
                            title={tx.reference ?? undefined}
                          >
                            {tx.reference ?? (tx.ledger_display_id ? '' : '—')}
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table>
            </div>
            <Pager
              page={page}
              onPage={setPage}
              pageSize={25}
              count={rows.length}
              total={data.total}
            />
          </>
        )}
      </Container>
    </>
  );
};
