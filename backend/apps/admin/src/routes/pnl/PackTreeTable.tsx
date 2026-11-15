import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Text } from '@medusajs/ui';
import type { PnlPair, PnlPackTree } from '../../lib/admin-rest';
import {
  FRANCHISE_LABEL,
  type SpriteFranchise,
} from '../../lib/sprite-franchise';
import { sen, vs } from './pnl-format';

const franchiseLabel = (category: string | null, other: string): string =>
  category === null
    ? other
    : (FRANCHISE_LABEL[category as SpriteFranchise] ??
      category.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));

export type TreeColumn<F> = { header: string; cell: (f: F) => ReactNode };

/** A row under the tree: label, the total column and vs previous. */
export type FooterRow = { label: string; pair: PnlPair; strong?: boolean };

const Blank = ({ n }: { n: number }) => (
  <>
    {Array.from({ length: n }, (_, i) => (
      <Table.Cell key={i} />
    ))}
  </>
);

/** Franchise → type → pack table shared by the P&L sections (spec §1, §6).
 *  Columns sit between the pack name and the section's total. */
export function PackTreeTable<F extends { total_sen: number }>({
  franchises,
  columns,
  totalHeader,
  footer,
}: {
  franchises: PnlPackTree<F>;
  columns: TreeColumn<F>[];
  totalHeader: string;
  footer: FooterRow[];
}) {
  const { t } = useTranslation();
  const other = t('pnl.packSales.noType');
  const typeLabel = (pt: string | null) =>
    pt === null ? other : t(`packs.packType.${pt}`, { defaultValue: pt });
  const gap = columns.length;

  return (
    <div className="overflow-x-auto border-t">
      {/* Amounts stay on one line; the table scrolls sideways on phones. */}
      <Table className="whitespace-nowrap">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t('pnl.packSales.pack')}</Table.HeaderCell>
            {columns.map((c) => (
              <Table.HeaderCell key={c.header} className="text-right">
                {c.header}
              </Table.HeaderCell>
            ))}
            <Table.HeaderCell className="text-right">
              {totalHeader}
            </Table.HeaderCell>
            <Table.HeaderCell className="text-right">
              {t('pnl.packSales.vsPrevious')}
            </Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {franchises.map((f) => (
            <Fragment key={`f-${f.category}`}>
              <Table.Row className="bg-ui-bg-subtle">
                <Table.Cell className="font-medium">
                  {franchiseLabel(f.category, other)}
                </Table.Cell>
                <Blank n={gap} />
                <Table.Cell className="text-right font-medium tabular-nums">
                  {sen(f.total.current_sen)}
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                  {vs(f.total)}
                </Table.Cell>
              </Table.Row>
              {f.types.map((ty) => (
                <Fragment key={`t-${f.category}-${ty.pack_type}`}>
                  <Table.Row>
                    <Table.Cell className="font-medium">
                      {/* Indent inside the cell: Table.Cell's own padding wins over pl-*. */}
                      <span className="pl-4">{typeLabel(ty.pack_type)}</span>
                    </Table.Cell>
                    <Blank n={gap} />
                    <Table.Cell className="text-right tabular-nums">
                      {sen(ty.total.current_sen)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {vs(ty.total)}
                    </Table.Cell>
                  </Table.Row>
                  {ty.packs.map((p) => (
                    <Table.Row key={p.slug}>
                      <Table.Cell>
                        <div className="flex flex-col py-1 pl-8">
                          <span>{p.title}</span>
                          <Text size="xsmall" className="text-ui-fg-subtle">
                            {sen(p.price_sen)}
                            {/* Two packs can share a title (old and new welcome pack): add the slug. */}
                            {ty.packs.filter((x) => x.title === p.title)
                              .length > 1 && ` · ${p.slug}`}
                          </Text>
                        </div>
                      </Table.Cell>
                      {columns.map((c) => (
                        <Table.Cell
                          key={c.header}
                          className="text-right tabular-nums"
                        >
                          {c.cell(p.current)}
                        </Table.Cell>
                      ))}
                      <Table.Cell className="text-right font-medium tabular-nums">
                        {sen(p.current.total_sen)}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                        {vs({
                          current_sen: p.current.total_sen,
                          previous_sen: p.previous?.total_sen ?? null,
                        })}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Fragment>
              ))}
            </Fragment>
          ))}
          {footer.map((r) => (
            <Table.Row
              key={r.label}
              className={r.strong ? 'bg-ui-bg-subtle' : ''}
            >
              <Table.Cell
                className={r.strong ? 'font-medium' : 'text-ui-fg-subtle'}
              >
                {r.label}
              </Table.Cell>
              <Blank n={gap} />
              <Table.Cell
                className={`text-right tabular-nums ${r.strong ? 'font-medium' : ''}`}
              >
                {sen(r.pair.current_sen)}
              </Table.Cell>
              <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                {vs(r.pair)}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}
