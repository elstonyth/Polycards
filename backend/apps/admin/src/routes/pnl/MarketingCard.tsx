import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Table, Text } from '@medusajs/ui';
import type {
  PnlCardSource,
  PnlCashRewardSource,
  PnlCreditSource,
  PnlMarketing,
  PnlPair,
} from '../../lib/admin-rest';
import { Hint } from '../../components/Hint';
import { sen, vs } from './pnl-format';

// Display order (key order). The type-only seam carries no values, so the
// lists live here as records keyed by the backend's unions: a source added or
// dropped there fails this typecheck.
const CREDIT_ORDER: Record<PnlCreditSource, true> = {
  adjustment: true,
  checkin: true,
  task: true,
  weekly_challenge: true,
  returned: true,
  lucky_draw: true,
  other: true,
};
const CARD_ORDER: Record<PnlCardSource, true> = {
  checkin: true,
  task: true,
  weekly_challenge: true,
};
const CASH_ORDER: Record<PnlCashRewardSource, true> = {
  checkin: true,
  task: true,
  weekly_challenge: true,
  other: true,
};
const PNL_CREDIT_SOURCES = Object.keys(CREDIT_ORDER) as PnlCreditSource[];
const PNL_CARD_SOURCES = Object.keys(CARD_ORDER) as PnlCardSource[];
const PNL_CASH_SOURCES = Object.keys(CASH_ORDER) as PnlCashRewardSource[];

const shows = (p: PnlPair) =>
  p.current_sen !== 0 || (p.previous_sen ?? 0) !== 0;

type Line = {
  key: string;
  label: ReactNode;
  qty?: ReactNode;
  pair: PnlPair;
  /** group = a subtotal row; item = indented under it; total = the section total. */
  kind: 'group' | 'item' | 'total';
  muted?: boolean;
};

/** Marketing expenses (P&L spec §7): free credit used, free cards, free
 *  packs and referral commission. Free credit given is information only. */
export const MarketingCard = ({ data }: { data: PnlMarketing }) => {
  const { t } = useTranslation();
  const source = (s: string) => t(`pnl.marketing.source.${s}`);
  const n = (v: number) => v.toLocaleString('en-US');

  const lines: Line[] = [
    {
      key: 'used',
      label: t('pnl.marketing.creditUsed'),
      pair: data.credit_used.total,
      kind: 'group',
    },
    ...PNL_CREDIT_SOURCES.filter(
      (s) =>
        (s !== 'returned' && s !== 'lucky_draw' && s !== 'other') ||
        shows(data.credit_used.by_source[s]),
    ).map((s): Line => ({
      key: `used-${s}`,
      label: s === 'lucky_draw' ? t('pnl.marketing.luckyDrawUsed') : source(s),
      pair: data.credit_used.by_source[s],
      kind: 'item',
      muted: s === 'lucky_draw',
    })),
    ...(shows(data.credit_used.returned_back)
      ? [
          {
            key: 'used-returned-back',
            label: t('pnl.marketing.returnedBack'),
            pair: data.credit_used.returned_back,
            kind: 'item' as const,
            muted: true,
          },
        ]
      : []),
    {
      key: 'cards',
      label: t('pnl.marketing.freeCards'),
      pair: data.free_cards.total,
      kind: 'group',
    },
    ...PNL_CARD_SOURCES.map((s): Line => {
      const c = data.free_cards.by_source[s];
      return {
        key: `cards-${s}`,
        label: source(s),
        qty: t('pnl.marketing.cardsQty', {
          count: c.cards,
          cards: n(c.cards),
          sold: n(c.sold),
        }),
        pair: c.value,
        kind: 'item',
      };
    }),
    {
      key: 'packs',
      label: t('pnl.marketing.freePacks'),
      pair: data.free_packs.total,
      kind: 'group',
    },
    ...data.free_packs.packs.map((p): Line => {
      const qty = Object.values(p.qty).reduce((a, b) => a + b, 0);
      return {
        key: `pack-${p.slug}`,
        label: (
          <span className="flex flex-col py-1">
            <span>{p.title}</span>
            <Text size="xsmall" className="text-ui-fg-subtle">
              {p.qty.welcome > 0
                ? t('pnl.marketing.welcomeFree')
                : sen(p.price_sen)}
            </Text>
          </span>
        ),
        qty: (
          <span className="inline-flex items-center gap-1">
            {n(qty)}
            {qty > 0 && <Hint text={t('pnl.marketing.packQtyHint', p.qty)} />}
          </span>
        ),
        pair: p.value,
        kind: 'item',
      };
    }),
    {
      key: 'referral',
      label: t('pnl.marketing.referral'),
      pair: data.referral,
      kind: 'group',
    },
    // Reward credits paid as cash (before free credit, 11 Oct): shown only
    // when the period has any (decision 24).
    ...(shows(data.cash_rewards.total)
      ? [
          {
            key: 'cash',
            label: t('pnl.marketing.cashRewards'),
            pair: data.cash_rewards.total,
            kind: 'group' as const,
          },
          ...PNL_CASH_SOURCES.filter((s) =>
            shows(data.cash_rewards.by_source[s]),
          ).map((s) => ({
            key: `cash-${s}`,
            label: t(`pnl.marketing.cashSource.${s}`),
            pair: data.cash_rewards.by_source[s],
            kind: 'item' as const,
          })),
        ]
      : []),
    {
      key: 'total',
      label: t('pnl.marketing.total'),
      pair: data.total,
      kind: 'total',
    },
    {
      key: 'given',
      label: t('pnl.marketing.creditGiven'),
      pair: data.credit_given.total,
      kind: 'group',
      muted: true,
    },
    ...(['adjustment', 'checkin', 'task', 'weekly_challenge'] as const).map(
      (s): Line => ({
        key: `given-${s}`,
        label: source(s),
        pair: data.credit_given.by_source[s],
        kind: 'item',
        muted: true,
      }),
    ),
    {
      key: 'removed',
      label: t('pnl.marketing.removed'),
      pair: data.credit_given.removed,
      kind: 'item',
      muted: true,
    },
  ];

  return (
    <Container className="pc-settle p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('pnl.marketing.title')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('pnl.marketing.subtitle')}
        </Text>
      </div>
      <div className="overflow-x-auto border-t">
        {/* Amounts stay on one line; the table scrolls sideways on phones. */}
        <Table className="whitespace-nowrap">
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t('pnl.marketing.item')}</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('pnl.marketing.qty')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('pnl.marketing.amount')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('pnl.packSales.vsPrevious')}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {lines.map((l) => (
              <Table.Row
                key={l.key}
                className={l.kind === 'item' ? '' : 'bg-ui-bg-subtle'}
              >
                <Table.Cell
                  className={`${l.kind === 'item' ? '' : 'font-medium'} ${l.muted ? 'text-ui-fg-subtle' : ''}`}
                >
                  {/* Indent inside the cell: Table.Cell's own padding wins over pl-*. */}
                  {l.kind === 'item' ? (
                    <span className="block pl-4">{l.label}</span>
                  ) : (
                    l.label
                  )}
                </Table.Cell>
                <Table.Cell className="text-right tabular-nums">
                  {l.qty}
                </Table.Cell>
                <Table.Cell
                  className={`text-right tabular-nums ${l.kind === 'item' ? '' : 'font-medium'} ${l.muted ? 'text-ui-fg-subtle' : ''}`}
                >
                  {sen(l.pair.current_sen)}
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                  {vs(l.pair)}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    </Container>
  );
};
