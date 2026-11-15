import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Text } from '@medusajs/ui';
import { TriangleDownMini, TriangleRightMini } from '@medusajs/icons';
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

/** `id` is stable (not the translated header): it keys the reader's saved
 *  show/hide choice. */
export type TreeColumn<F> = {
  id: string;
  header: string;
  cell: (f: F) => ReactNode;
};

/** Ids of the two columns every tree ends with, for the Columns menu. */
export const TREE_TOTAL = 'total';
export const TREE_VS = 'vs';

/** A row under the tree: label, the total column and vs previous. */
export type FooterRow = { label: string; pair: PnlPair; strong?: boolean };

const Blank = ({ n }: { n: number }) => (
  <>
    {Array.from({ length: n }, (_, i) => (
      <Table.Cell key={i} />
    ))}
  </>
);

/** A franchise or type label that folds the rows under it away. */
const GroupToggle = ({
  label,
  open,
  onToggle,
  indent,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  indent?: boolean;
}) => {
  const { t } = useTranslation();
  const Icon = open ? TriangleDownMini : TriangleRightMini;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={t(open ? 'pnl.view.collapse' : 'pnl.view.expand', {
        name: label,
      })}
      className={`txt-compact-small-plus text-ui-fg-base focus-visible:shadow-borders-focus -my-1 inline-flex items-center gap-1 rounded py-1 outline-none ${indent ? 'ml-4' : ''}`}
    >
      <Icon className="text-ui-fg-muted" />
      {label}
    </button>
  );
};

/** Franchise → type → pack table shared by the P&L sections (spec §1, §6).
 *  Columns sit between the pack name and the section's total. `hidden` holds
 *  the column ids the reader turned off, `collapsed` the folded group rows. */
export function PackTreeTable<F extends { total_sen: number }>({
  franchises,
  columns: allColumns,
  totalHeader,
  footer,
  hidden,
  collapsed,
  onToggleRow,
}: {
  franchises: PnlPackTree<F>;
  columns: TreeColumn<F>[];
  totalHeader: string;
  footer: FooterRow[];
  hidden: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggleRow: (key: string) => void;
}) {
  const { t } = useTranslation();
  const other = t('pnl.packSales.noType');
  const typeLabel = (pt: string | null) =>
    pt === null ? other : t(`packs.packType.${pt}`, { defaultValue: pt });
  const columns = allColumns.filter((c) => !hidden.has(c.id));
  const gap = columns.length;
  const showTotal = !hidden.has(TREE_TOTAL);
  const showVs = !hidden.has(TREE_VS);
  /** A row's total and vs-previous cells, less the hidden ones. */
  const tail = (pair: PnlPair, strong: boolean) => (
    <>
      {showTotal && (
        <Table.Cell
          className={`text-right tabular-nums ${strong ? 'font-medium' : ''}`}
        >
          {sen(pair.current_sen)}
        </Table.Cell>
      )}
      {showVs && (
        <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
          {vs(pair)}
        </Table.Cell>
      )}
    </>
  );

  return (
    <div className="overflow-x-auto border-t">
      {/* Amounts stay on one line; the table scrolls sideways on phones. */}
      <Table className="whitespace-nowrap">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t('pnl.packSales.pack')}</Table.HeaderCell>
            {columns.map((c) => (
              <Table.HeaderCell key={c.id} className="text-right">
                {c.header}
              </Table.HeaderCell>
            ))}
            {showTotal && (
              <Table.HeaderCell className="text-right">
                {totalHeader}
              </Table.HeaderCell>
            )}
            {showVs && (
              <Table.HeaderCell className="text-right">
                {t('pnl.packSales.vsPrevious')}
              </Table.HeaderCell>
            )}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {franchises.map((f) => {
            const fKey = `f:${f.category}`;
            const fOpen = !collapsed.has(fKey);
            return (
              <Fragment key={fKey}>
                <Table.Row className="bg-ui-bg-subtle">
                  <Table.Cell>
                    <GroupToggle
                      label={franchiseLabel(f.category, other)}
                      open={fOpen}
                      onToggle={() => onToggleRow(fKey)}
                    />
                  </Table.Cell>
                  <Blank n={gap} />
                  {tail(f.total, true)}
                </Table.Row>
                {fOpen &&
                  f.types.map((ty) => {
                    const tKey = `t:${f.category}:${ty.pack_type}`;
                    const tOpen = !collapsed.has(tKey);
                    return (
                      <Fragment key={tKey}>
                        <Table.Row>
                          <Table.Cell>
                            {/* Indent inside the cell: Table.Cell's own padding wins over pl-*. */}
                            <GroupToggle
                              label={typeLabel(ty.pack_type)}
                              open={tOpen}
                              onToggle={() => onToggleRow(tKey)}
                              indent
                            />
                          </Table.Cell>
                          <Blank n={gap} />
                          {tail(ty.total, false)}
                        </Table.Row>
                        {tOpen &&
                          ty.packs.map((p) => (
                            <Table.Row key={p.slug}>
                              <Table.Cell>
                                <div className="flex flex-col py-1 pl-8">
                                  <span>{p.title}</span>
                                  <Text
                                    size="xsmall"
                                    className="text-ui-fg-subtle"
                                  >
                                    {sen(p.price_sen)}
                                    {/* Two packs can share a title (old and new welcome pack): add the slug. */}
                                    {ty.packs.filter((x) => x.title === p.title)
                                      .length > 1 && ` · ${p.slug}`}
                                  </Text>
                                </div>
                              </Table.Cell>
                              {columns.map((c) => (
                                <Table.Cell
                                  key={c.id}
                                  className="text-right tabular-nums"
                                >
                                  {c.cell(p.current)}
                                </Table.Cell>
                              ))}
                              {tail(
                                {
                                  current_sen: p.current.total_sen,
                                  previous_sen: p.previous?.total_sen ?? null,
                                },
                                true,
                              )}
                            </Table.Row>
                          ))}
                      </Fragment>
                    );
                  })}
              </Fragment>
            );
          })}
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
              {tail(r.pair, !!r.strong)}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}
