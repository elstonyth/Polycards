import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Table, Text } from '@medusajs/ui';
import {
  useCustomerMoney,
  useCustomerTransactions,
} from '../../../lib/queries';
import type { SupportTransaction } from '../../../lib/admin-rest';
import { rm } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';
import { delta } from '../../economy/signs';
import { StatTile } from './MoneyCards';
import {
  CardLine,
  DetailDrawer,
  DetailRow,
  DetailRows,
  FilterPills,
  TableState,
  When,
  openableRow,
  whenText,
} from './bits';
import {
  WALLET_FILTERS,
  ledgerKind,
  ledgerSubject,
  type WalletFilter,
} from './ledger-kind';
import { withdrawableNote } from './wallet-note';

const FILTERS = Object.keys(WALLET_FILTERS) as WalletFilter[];

// Dot colour per direction: money in green, out red, bonus purple.
const dot = (kind: string, amount: number) =>
  kind === 'bonusGiven' || kind === 'bonusTaken'
    ? 'bg-ui-tag-purple-icon'
    : amount > 0
      ? 'bg-ui-tag-green-icon'
      : 'bg-ui-tag-red-icon';

/** An admin's note has spaces; a gateway or order reference never does. */
const isNote = (reference: string | null) =>
  !!reference && /\s/.test(reference);

const TransactionDrawer = ({
  tx,
  title,
  onClose,
}: {
  tx: SupportTransaction;
  title: string;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const bonus = tx.bonus ?? 0;
  const note = isNote(tx.reference);
  return (
    <DetailDrawer title={title} onClose={onClose}>
      <DetailRows>
        <DetailRow label={t('support.amount')} value={delta(tx.amount)} />
        {bonus !== 0 && (
          <DetailRow label={t('playerDetail.bonusPart')} value={delta(bonus)} />
        )}
        <DetailRow
          label={t('playerDetail.balanceAfter')}
          value={tx.balance_after == null ? null : rm(tx.balance_after)}
        />
        <DetailRow label={t('support.when')} value={whenText(tx.created_at)} />
        <DetailRow label={t('pulls.pack')} value={tx.pack_title} />
        <DetailRow
          label={t('playerDetail.ledgerId')}
          code={tx.ledger_display_id}
        />
        {tx.order_id ? (
          <DetailRow label={t('players.order')} code={tx.order_id} />
        ) : note ? (
          <DetailRow label={t('playerDetail.note')} value={tx.reference} />
        ) : (
          <DetailRow
            label={t('playerMoney.colReference')}
            code={tx.reference}
          />
        )}
      </DetailRows>
      {!!tx.cards?.length && (
        <div className="flex flex-col gap-3 px-6 py-4">
          <Text size="small" weight="plus">
            {t('playerDetail.cards', { count: tx.cards.length })}
          </Text>
          {tx.cards.map((c) => (
            <CardLine key={c.pull_id} name={c.name} image={c.image} />
          ))}
        </div>
      )}
    </DetailDrawer>
  );
};

/**
 * The wallet as support needs it: what the player holds, what can leave
 * right now and why not (the withdraw button's own gate: frozen, never
 * topped up, bonus, money still to use on packs), then the ledger in
 * words, filterable by kind. A row opens everything known about it.
 */
export const WalletTab = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<WalletFilter>('all');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<SupportTransaction | null>(null);
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
  const kindLabel = (tx: SupportTransaction) => {
    const kind = ledgerKind(tx.reason, tx.amount);
    return kind === 'other' ? tx.reason : t(`playerMoney.kind.${kind}`);
  };

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
          <FilterPills
            label={t('playerMoney.historyTitle')}
            value={filter}
            options={FILTERS.map((f) => ({
              value: f,
              label: t(`playerMoney.filter.${f}`),
            }))}
            onChange={(f) => {
              setFilter(f);
              setPage(0);
            }}
          />
        </div>

        {isError ? (
          <TableState isError />
        ) : !data ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : rows.length === 0 ? (
          <TableState empty={t('support.empty')} />
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
                    <Table.HeaderCell className="text-right">
                      {t('playerDetail.balanceAfter')}
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
                    const subject = ledgerSubject(tx);
                    return (
                      <Table.Row
                        key={tx.id}
                        {...openableRow(() => setOpen(tx))}
                      >
                        <Table.Cell className="whitespace-nowrap">
                          <When iso={tx.created_at} />
                        </Table.Cell>
                        <Table.Cell className="max-w-[22rem]">
                          <span className="inline-flex items-center gap-2 whitespace-nowrap">
                            <span
                              aria-hidden
                              className={`size-2 shrink-0 rounded-full ${dot(kind, tx.amount)}`}
                            />
                            {kindLabel(tx)}
                          </span>
                          {(subject || tx.order_id) && (
                            <div
                              className="text-ui-fg-subtle txt-compact-xsmall truncate"
                              title={subject ?? undefined}
                            >
                              {subject ??
                                t('playerDetail.orderRef', {
                                  id: tx.order_id?.slice(-6),
                                })}
                            </div>
                          )}
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
                        <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-right tabular-nums">
                          {tx.balance_after == null
                            ? '—'
                            : rm(tx.balance_after)}
                        </Table.Cell>
                        <Table.Cell className="max-w-[16rem]">
                          {tx.ledger_display_id && (
                            <div className="txt-compact-small-plus font-mono">
                              {tx.ledger_display_id}
                            </div>
                          )}
                          {/* Gateway refs run to 40 characters: cut here, whole
                              in the panel. A code reads in mono; an admin's
                              note stays in the text face. Hidden on a shipping
                              row, whose order already reads under its type. */}
                          {!tx.order_id && (
                            <div
                              className={`text-ui-fg-subtle txt-compact-xsmall truncate ${isNote(tx.reference) ? '' : 'font-mono'}`}
                              title={tx.reference ?? undefined}
                            >
                              {tx.reference ??
                                (tx.ledger_display_id ? '' : '—')}
                            </div>
                          )}
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

      {open && (
        <TransactionDrawer
          tx={open}
          title={kindLabel(open)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
};
