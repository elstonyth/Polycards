import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Container, Heading, Table, Text } from '@medusajs/ui';
import type { CustomerGacha, CustomerMoney } from '../../../lib/admin-rest';
import { rm, timeAgo } from '../../../lib/format';
import { Hint } from '../../../components/Hint';
import { CountUp } from '../../overview/KpiTiles';
import { delta, signed } from '../../economy/signs';
import { standing, type StandingRow } from './standing';

// The player page's money (GET /admin/customers/:id/money): four headline
// tiles, top-ups and withdrawals by period, where the house stands with this
// player, and their play. Wrapped by the page in .pc-dashboard, so the
// settle-in and bar-grow motion (admin-ui.css) applies here too.

const PERIODS = ['today', 'd7', 'month', 'all'] as const;

const BAR: Record<StandingRow['tone'], string> = {
  in: 'bg-ui-tag-green-icon',
  out: 'bg-ui-tag-red-icon',
  kept: 'bg-ui-tag-green-icon opacity-50',
  loss: 'bg-ui-tag-red-icon opacity-50',
};

const Tile = ({
  label,
  hint,
  value,
  note,
  className = 'bg-ui-bg-subtle',
  valueClass = '',
}: {
  label: string;
  hint?: string;
  value: ReactNode;
  note?: ReactNode;
  className?: string;
  valueClass?: string;
}) => (
  <div className={`flex min-w-0 flex-col gap-0.5 px-6 py-4 ${className}`}>
    <div className="flex items-center gap-1.5">
      <Text size="small" className="text-ui-fg-subtle">
        {label}
      </Text>
      {hint && <Hint text={hint} />}
    </div>
    <Text
      size="xlarge"
      weight="plus"
      className={`truncate tabular-nums ${valueClass}`}
    >
      {value}
    </Text>
    {note && (
      <Text size="xsmall" className="text-ui-fg-subtle">
        {note}
      </Text>
    )}
  </div>
);

/** Result, total contribution, wallet and vault: the four numbers staff
 *  check first. */
export const MoneySummary = ({
  money,
  view,
}: {
  money: CustomerMoney | undefined;
  view: CustomerGacha | undefined;
}) => {
  const { t } = useTranslation();
  const result = money?.owed.if_all_cashed_out ?? 0;
  const resultTone =
    result > 0
      ? 'text-ui-tag-green-text'
      : result < 0
        ? 'text-ui-fg-error'
        : '';
  const cards = money
    ? money.owed.cards.count + money.owed.cards_no_topup.count
    : null;
  const sellback = money
    ? money.owed.cards.sellback + money.owed.cards_no_topup.sellback
    : null;
  return (
    <div className="bg-ui-border-base grid grid-cols-1 gap-px border-t sm:grid-cols-2 xl:grid-cols-4">
      <Tile
        label={
          !money
            ? t('playerMoney.resultLabel')
            : result > 0
              ? t('playerMoney.up')
              : result < 0
                ? t('playerMoney.down')
                : t('playerMoney.even')
        }
        hint={t('playerMoney.resultHint')}
        value={
          money ? (
            <CountUp value={Math.abs(result)} format={(n) => rm(n)} />
          ) : (
            '—'
          )
        }
        valueClass={resultTone}
        note={t('playerMoney.resultNote')}
      />
      <Tile
        label={t('playerMoney.contribution')}
        hint={t('playerMoney.contributionHint')}
        value={money ? signed(money.periods.all.contribution) : '—'}
        valueClass={
          money && money.periods.all.contribution < 0 ? 'text-ui-fg-error' : ''
        }
        note={
          money
            ? t('playerMoney.contributionNote', {
                topups: rm(money.periods.all.topups.amount),
                withdrawals: rm(money.periods.all.withdrawals.amount),
              })
            : undefined
        }
      />
      <Tile
        label={t('playerMoney.wallet')}
        value={view ? rm(view.balance) : '—'}
        note={
          view && view.bonus_balance > 0
            ? t('playerMoney.walletBonus', { amount: rm(view.bonus_balance) })
            : t('playerMoney.walletNoBonus')
        }
      />
      <Tile
        label={t('playerMoney.vault')}
        value={
          cards === null ? '—' : t('playerMoney.vaultCards', { count: cards })
        }
        note={
          sellback === null
            ? undefined
            : t('playerMoney.vaultNote', { amount: rm(sellback) })
        }
      />
    </div>
  );
};

/** Top-ups and withdrawals today, over the last 7 days, this month and all
 *  time, and when the player last moved money or played. */
export const PeriodsCard = ({ money }: { money: CustomerMoney }) => {
  const { t } = useTranslation();
  const p = money.periods;
  const ago = (iso: string | null) =>
    iso ? timeAgo(iso) : t('playerMoney.never');
  const amountCell = (key: string, amount: number, count: number) => (
    <Table.Cell key={key} className="text-right tabular-nums">
      <div>{rm(amount)}</div>
      <div className="text-ui-fg-subtle txt-compact-xsmall">
        {t('playerMoney.payments', { count })}
      </div>
    </Table.Cell>
  );
  return (
    <Container className="pc-settle p-0 [animation-delay:40ms]">
      <div className="px-6 py-4">
        <Heading level="h2">{t('playerMoney.periodsTitle')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('playerMoney.last', {
            topup: ago(money.last.topup_at),
            withdrawal: ago(money.last.withdrawal_at),
            open: ago(money.last.open_at),
          })}
        </Text>
      </div>
      <div
        className="overflow-x-auto border-t"
        tabIndex={0}
        role="region"
        aria-label={t('playerMoney.periodsTitle')}
      >
        {/* Never wraps: on a phone the region scrolls sideways instead. */}
        <Table className="whitespace-nowrap">
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell />
              {PERIODS.map((k) => (
                <Table.HeaderCell key={k} className="text-right">
                  {t(`playerMoney.period.${k}`)}
                </Table.HeaderCell>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            <Table.Row>
              <Table.Cell>{t('playerMoney.topups')}</Table.Cell>
              {PERIODS.map((k) =>
                amountCell(k, p[k].topups.amount, p[k].topups.count),
              )}
            </Table.Row>
            <Table.Row>
              <Table.Cell>
                <span className="inline-flex items-center gap-1.5">
                  {t('playerMoney.withdrawals')}
                  <Hint text={t('playerMoney.withdrawalsHint')} />
                </span>
              </Table.Cell>
              {PERIODS.map((k) =>
                amountCell(k, p[k].withdrawals.amount, p[k].withdrawals.count),
              )}
            </Table.Row>
            <Table.Row>
              <Table.Cell className="txt-compact-small-plus">
                {t('playerMoney.contribution')}
              </Table.Cell>
              {PERIODS.map((k) => (
                <Table.Cell
                  key={k}
                  className={`txt-compact-small-plus text-right tabular-nums ${p[k].contribution < 0 ? 'text-ui-fg-error' : ''}`}
                >
                  {delta(p[k].contribution)}
                </Table.Cell>
              ))}
            </Table.Row>
          </Table.Body>
        </Table>
      </div>
    </Container>
  );
};

/** Where the house stands: the Profit report's trail for this player alone,
 *  carried on down to "if they cashed out now". */
export const StandingCard = ({ money }: { money: CustomerMoney }) => {
  const { t } = useTranslation();
  const { cash, owed } = money;
  const { rows } = standing(money);
  const missing = cash.topups.missing_fees + cash.withdrawals.missing_fees;
  const grossFloor = cash.topups.missing_gross > 0;
  const noTopupCards = owed.cards_no_topup.count;
  const hints: Partial<Record<StandingRow['key'], string>> = {
    fees: t('profit.feeSplit', {
      topups: rm(cash.topups.fees),
      payouts: rm(cash.withdrawals.fees),
    }),
    fx: t('profit.fxHint'),
    cards: t('playerMoney.cardsHint'),
  };
  return (
    <Container className="pc-settle flex flex-col gap-4 [animation-delay:80ms]">
      <div className="flex items-center gap-1.5">
        <Heading level="h2">{t('playerMoney.standingTitle')}</Heading>
        <Hint text={t('playerMoney.standingHint')} />
        {(grossFloor || missing > 0) && (
          <Badge size="2xsmall" color="orange">
            {t('profit.estimate')}
          </Badge>
        )}
      </div>

      <ul className="flex flex-col gap-2.5">
        {rows.map((r) => {
          const hint = hints[r.key];
          return (
            // Phones: label and amount on one line, the bar under them.
            <li
              key={r.key}
              className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,11rem)_minmax(6rem,1fr)_8.5rem] ${r.total ? 'border-t pt-2.5' : ''}`}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <Text
                  size="small"
                  weight={r.total ? 'plus' : 'regular'}
                  className={r.total ? '' : 'text-ui-fg-subtle'}
                >
                  {t(`playerMoney.trail.${r.key}`)}
                </Text>
                {hint && <Hint text={hint} />}
              </div>
              <div
                className="bg-ui-bg-component relative col-span-2 row-start-2 h-3 overflow-hidden rounded-full sm:col-span-1 sm:row-start-auto"
                aria-hidden
              >
                <div
                  className={`pc-grow absolute inset-y-0 origin-left rounded-full ${BAR[r.tone]}`}
                  style={{ left: `${r.left}%`, width: `${r.width}%` }}
                />
              </div>
              <Text
                size="small"
                weight="plus"
                className={`text-right tabular-nums ${
                  r.tone === 'loss'
                    ? 'text-ui-fg-error'
                    : r.key === 'result' && r.amount > 0
                      ? 'text-ui-tag-green-text'
                      : ''
                }`}
              >
                {r.key === 'topups' && grossFloor ? '≥ ' : ''}
                {r.key === 'fx' && r.amount > 0 ? '+ ' : ''}
                {signed(r.amount)}
              </Text>
            </li>
          );
        })}
      </ul>

      {(grossFloor ||
        missing > 0 ||
        owed.wallet_no_topup > 0 ||
        noTopupCards > 0) && (
        <div className="flex flex-col gap-1">
          {grossFloor && (
            <Text size="xsmall" className="text-ui-fg-subtle">
              {t('profit.grossFloor', { count: cash.topups.missing_gross })}
            </Text>
          )}
          {missing > 0 && (
            <Text size="xsmall" className="text-ui-fg-subtle">
              {t('profit.feeFloor', { count: missing })}
            </Text>
          )}
          {(owed.wallet_no_topup > 0 || noTopupCards > 0) && (
            <Text size="xsmall" className="text-ui-fg-subtle">
              {t('playerMoney.noTopup', {
                amount: rm(owed.wallet_no_topup),
                count: noTopupCards,
              })}
            </Text>
          )}
        </div>
      )}
    </Container>
  );
};

/** Their play, all time: what they spent on packs, what the cards were
 *  worth, and the credit that moved around it. */
export const PlayCard = ({ money }: { money: CustomerMoney }) => {
  const { t } = useTranslation();
  const { activity, play } = money;
  const stats: {
    label: string;
    hint?: string;
    value: string;
    note?: string;
  }[] = [
    { label: t('playerMoney.packSpend'), value: rm(activity.pack_sales) },
    {
      label: t('playerMoney.cardsWon'),
      hint: t('playerMoney.cardsWonHint'),
      value: rm(play.cards_won.value),
      note: t('playerMoney.vaultCards', { count: play.cards_won.count }),
    },
    {
      label: t('playerMoney.return'),
      hint: t('playerMoney.returnHint'),
      value:
        play.return_pct === null
          ? '—'
          : t('playerMoney.returnValue', { pct: play.return_pct }),
    },
    { label: t('playerMoney.soldBack'), value: rm(activity.sellbacks) },
    { label: t('playerMoney.promoGiven'), value: rm(activity.promo_given) },
  ];
  if (activity.referral_commission !== 0)
    stats.push({
      label: t('playerMoney.referral'),
      value: rm(activity.referral_commission),
    });
  return (
    <Container className="pc-settle p-0 [animation-delay:120ms]">
      <div className="flex items-center gap-2 px-6 py-4">
        <Heading level="h2">{t('playerMoney.playTitle')}</Heading>
        <Badge size="2xsmall" color="grey">
          {t('playerMoney.period.all')}
        </Badge>
      </div>
      {/* Wrapping flex, not a grid: a short last row stretches to the edge
          instead of leaving an empty cell (five or six stats). */}
      <div className="bg-ui-border-base flex flex-wrap gap-px border-t">
        {stats.map((s) => (
          <div
            key={s.label}
            className="bg-ui-bg-subtle flex min-w-[10rem] flex-1 flex-col gap-0.5 px-6 py-3"
          >
            <div className="flex items-center gap-1.5">
              <Text size="small" className="text-ui-fg-subtle">
                {s.label}
              </Text>
              {s.hint && <Hint text={s.hint} />}
            </div>
            <Text weight="plus" className="tabular-nums">
              {s.value}
            </Text>
            {s.note && (
              <Text size="xsmall" className="text-ui-fg-subtle">
                {s.note}
              </Text>
            )}
          </div>
        ))}
      </div>
    </Container>
  );
};
