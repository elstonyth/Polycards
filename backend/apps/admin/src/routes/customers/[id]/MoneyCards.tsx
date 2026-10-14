import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Container, Heading, Table, Text } from '@medusajs/ui';
import type { CustomerGacha, CustomerMoney } from '../../../lib/admin-rest';
import { rm, timeAgo } from '../../../lib/format';
import { Hint } from '../../../components/Hint';
import { CountUp } from '../../overview/KpiTiles';
import { delta, signed } from '../../economy/signs';

// The player page's money (GET /admin/customers/:id/money): four headline
// tiles, top-ups and withdrawals by period, and their play. Wrapped by the page in .pc-dashboard, so the
// settle-in motion (admin-ui.css) applies here too.

const PERIODS = ['today', 'd7', 'month', 'all'] as const;

export const StatTile = ({
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
      <StatTile
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
      <StatTile
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
      <StatTile
        label={t('playerMoney.wallet')}
        value={view ? rm(view.balance) : '—'}
        note={
          money
            ? [
                t('playerMoney.walletWithdrawable', {
                  amount: rm(money.wallet.withdrawable),
                }),
                money.wallet.bonus > 0
                  ? t('playerMoney.walletBonus', {
                      amount: rm(money.wallet.bonus),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
      />
      <StatTile
        // Vaulted AND being shipped (both still owed), so not the Vault tab's
        // count: a shipment in progress is named in the note.
        label={t('playerMoney.vault')}
        value={
          cards === null ? '—' : t('playerMoney.vaultCards', { count: cards })
        }
        note={
          sellback === null || !money
            ? undefined
            : [
                t('playerMoney.vaultNote', { amount: rm(sellback) }),
                money.owed.cards.delivering > 0
                  ? t('playerMoney.shipping', {
                      count: money.owed.cards.delivering,
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')
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
