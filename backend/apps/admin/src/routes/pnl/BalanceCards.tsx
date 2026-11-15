import { useTranslation } from 'react-i18next';
import { Container, Heading, Table, Text } from '@medusajs/ui';
import type {
  PnlAssetsSection,
  PnlBonusSource,
  PnlFloatingSection,
} from '../../lib/admin-rest';
import { sen } from './pnl-format';

type Line = {
  label: string;
  sen: number;
  note?: string;
  /** 0 = subtotal row, 1 = part, 2 = part of a part. */
  depth: 0 | 1 | 2;
  strong?: boolean;
};

const INDENT = ['', 'pl-4', 'pl-8'];

// Point in time: one amount per line, no "vs previous" column.
const Lines = ({ lines }: { lines: Line[] }) => {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto border-t">
      <Table className="whitespace-nowrap">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t('pnl.totals.line')}</Table.HeaderCell>
            <Table.HeaderCell className="text-right">
              {t('pnl.totals.amount')}
            </Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {lines.map((l) => (
            <Table.Row
              key={l.label}
              className={l.depth === 0 ? 'bg-ui-bg-subtle' : ''}
            >
              <Table.Cell
                className={l.depth === 0 ? 'font-medium' : 'text-ui-fg-subtle'}
              >
                {/* Indent inside the cell: Table.Cell's own padding wins over pl-*. */}
                <span className={INDENT[l.depth]}>{l.label}</span>
                {l.note && (
                  <span className="text-ui-fg-muted ml-2 text-xs">
                    {l.note}
                  </span>
                )}
              </Table.Cell>
              <Table.Cell
                className={`text-right tabular-nums ${
                  l.depth === 0 || l.strong ? 'font-medium' : ''
                }`}
              >
                {sen(l.sen)}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};

/** Unsold stock as of now (P&L spec §9): on hand less what open orders hold,
 *  at weighted-average supplier cost. */
export const AssetsCard = ({ data }: { data: PnlAssetsSection }) => {
  const { t } = useTranslation();
  return (
    <Container className="pc-settle p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('pnl.assets.title')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('pnl.assets.subtitle')}
        </Text>
        {data.no_cost_cards > 0 && (
          <Text size="small" className="text-ui-fg-subtle mt-1">
            {t('pnl.assets.noCostNote', { count: data.no_cost_cards })}
          </Text>
        )}
      </div>
      <Lines
        lines={[
          {
            label: t('pnl.assets.unsold'),
            note: t('pnl.assets.cards', { count: data.cards }),
            sen: data.total_sen,
            depth: 0,
          },
        ]}
      />
    </Container>
  );
};

// Display order (key order), keyed by the backend's union so a source added or
// dropped there fails this typecheck (ADR 0017).
const SOURCE_ORDER: Record<PnlBonusSource, true> = {
  adjustment: true,
  checkin: true,
  task: true,
  weekly_challenge: true,
  returned: true,
  lucky_draw: true,
  other: true,
};
const SOURCES = Object.keys(SOURCE_ORDER) as PnlBonusSource[];

/** Customer floating money as of now (P&L spec §10): wallets (withdrawable,
 *  unused free credit by source, locked cash) + cards at buyback value. */
export const FloatingMoneyCard = ({ data }: { data: PnlFloatingSection }) => {
  const { t } = useTranslation();
  const { wallet, cards } = data;
  return (
    <Container className="pc-settle p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('pnl.floating.title')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('pnl.floating.subtitle')}
        </Text>
      </div>
      <Lines
        lines={[
          {
            label: t('pnl.floating.withdrawable'),
            sen: wallet.withdrawable_sen,
            depth: 1,
          },
          {
            label: t('pnl.floating.freeCredit'),
            sen: wallet.free_credit_sen,
            depth: 1,
            strong: true,
          },
          // Lucky Draw prize credit shows only once one exists (none on prod yet).
          ...SOURCES.filter(
            (s) =>
              (s !== 'lucky_draw' && s !== 'other') ||
              wallet.free_credit_by_source[s] !== 0,
          ).map((s): Line => ({
            label: t(`pnl.floating.sources.${s}`),
            sen: wallet.free_credit_by_source[s],
            depth: 2,
          })),
          {
            label: t('pnl.floating.locked'),
            sen: wallet.locked_sen,
            depth: 1,
          },
          {
            label: t('pnl.floating.wallets'),
            sen: wallet.total_sen,
            depth: 0,
          },
          {
            label: t('pnl.floating.vault'),
            note: t('pnl.floating.cards', { count: cards.vault.cards }),
            sen: cards.vault.sen,
            depth: 1,
          },
          {
            label: t('pnl.floating.processing'),
            note: t('pnl.floating.cards', { count: cards.processing.cards }),
            sen: cards.processing.sen,
            depth: 1,
          },
          {
            label: t('pnl.floating.cardsTotal'),
            sen: cards.total_sen,
            depth: 0,
          },
          {
            label: t('pnl.floating.total'),
            sen: data.total_sen,
            depth: 0,
          },
        ]}
      />
    </Container>
  );
};
