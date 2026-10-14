import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Container, Heading, Table, Text } from '@medusajs/ui';
import type { ProfitReport } from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { useTableSort } from '../../lib/use-table-sort';

type SortKey = 'pack' | 'price' | 'ev' | 'rtp';

// The meter runs to 150%, so 100% (break-even) sits at two thirds.
const METER_MAX = 150;

const rateColor = (pct: number) =>
  pct > 100 ? 'red' : pct >= 95 ? 'orange' : 'grey';
const meterFill = (pct: number) =>
  pct > 100
    ? 'bg-ui-tag-red-icon'
    : pct >= 95
      ? 'bg-ui-tag-orange-icon'
      : 'bg-ui-tag-green-icon';

/** Expected value back per open with today's odds; over 100% loses money. */
export const PayoutRateCard = ({ data }: { data: ProfitReport }) => {
  const { t } = useTranslation();
  // Starts null = the server's order (highest rate first).
  const { sort, sortHeader } = useTableSort<SortKey>(null);
  const rows = useMemo(() => {
    if (!sort) return data.packs;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (p: ProfitReport['packs'][number]): number | string =>
      sort.key === 'pack'
        ? p.title
        : sort.key === 'price'
          ? p.price
          : sort.key === 'ev'
            ? (p.ev ?? Number.NEGATIVE_INFINITY)
            : (p.rtp_pct ?? Number.NEGATIVE_INFINITY);
    return [...data.packs].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === 'string' && typeof bv === 'string') {
        return dir * av.localeCompare(bv);
      }
      return dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });
  }, [data.packs, sort]);

  return (
    <Container className="pc-settle p-0 [animation-delay:190ms]">
      <div className="px-6 py-4">
        <Heading level="h2">{t('profit.rtpTitle')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('profit.rtpSubtitle')}
        </Text>
      </div>
      {rows.length === 0 ? (
        <Text size="small" className="text-ui-fg-subtle border-t px-6 py-6">
          {t('profit.empty')}
        </Text>
      ) : (
        <div className="overflow-x-auto border-t">
          <Table>
            <Table.Header>
              <Table.Row>
                {sortHeader('pack', t('profit.pack'))}
                {sortHeader('price', t('profit.price'), true)}
                {sortHeader('ev', t('profit.expectedBack'), true)}
                {sortHeader('rtp', t('profit.rate'))}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((p) => (
                <Table.Row key={p.slug}>
                  <Table.Cell>{p.title}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    {rm(p.price)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                    {p.ev === null ? '—' : rm(p.ev)}
                  </Table.Cell>
                  <Table.Cell>
                    {p.rtp_pct === null ? (
                      '—'
                    ) : (
                      <div className="flex items-center gap-3">
                        <div
                          className="bg-ui-bg-component relative h-1.5 w-36 shrink-0 rounded-full"
                          aria-hidden
                        >
                          <div
                            className={`pc-grow absolute inset-y-0 left-0 origin-left rounded-full ${meterFill(p.rtp_pct)}`}
                            style={{
                              width: `${Math.min(100, (p.rtp_pct / METER_MAX) * 100)}%`,
                            }}
                          />
                          {/* Break-even mark at 100%. */}
                          <div className="bg-ui-fg-muted absolute -inset-y-1 left-2/3 w-px" />
                        </div>
                        <Badge
                          size="2xsmall"
                          color={rateColor(p.rtp_pct)}
                          className="tabular-nums"
                        >
                          {p.rtp_pct.toFixed(1)}%
                        </Badge>
                      </div>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </Container>
  );
};
