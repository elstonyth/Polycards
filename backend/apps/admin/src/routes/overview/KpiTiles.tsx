import { useTranslation } from 'react-i18next';
import { Badge, Container, Text } from '@medusajs/ui';
import type { StatsFigures, StatsReport } from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { deltaTone, percentChange } from '../../lib/dashboard';
import { useCountUp } from '../../lib/use-count-up';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

const TONE_COLOR = { good: 'green', bad: 'red', flat: 'grey' } as const;

/** ▲/▼ % against the previous window; "—" against a zero base. */
export const DeltaBadge = ({
  cur,
  prev,
  riseIsBad = false,
}: {
  cur: number;
  prev: number;
  riseIsBad?: boolean;
}) => {
  const pct = percentChange(cur, prev);
  const tone = deltaTone(cur, prev, riseIsBad);
  return (
    <Badge size="2xsmall" color={TONE_COLOR[tone]} className="tabular-nums">
      {pct === null
        ? '—'
        : `${pct > 0 ? '▲' : pct < 0 ? '▼' : ''} ${Math.abs(pct).toFixed(1)}%`}
    </Badge>
  );
};

/** Counts its number up from the last value shown whenever it changes. */
export const CountUp = ({
  value,
  format,
}: {
  value: number;
  format: (n: number) => string;
}) => <>{format(useCountUp(value))}</>;

const count = (n: number) => Math.round(n).toLocaleString('en-US');

interface Tile {
  key: keyof StatsFigures;
  money?: boolean;
  /** Money leaving: a rise is coloured as the bad direction. */
  outflow?: boolean;
  sub: (s: StatsFigures) => { key: string; values: Record<string, string> };
}

const TILES: Tile[] = [
  {
    key: 'signups',
    sub: () => ({ key: '', values: {} }),
  },
  {
    key: 'topup_amount',
    money: true,
    sub: (s) => ({
      key: 'dashboard.topupsSub',
      values: {
        count: count(s.topup_count),
        players: count(s.topup_customers),
      },
    }),
  },
  {
    key: 'first_topup_count',
    sub: (s) => ({
      key: 'dashboard.firstSub',
      values: { amount: rm(s.first_topup_amount) },
    }),
  },
  {
    key: 'withdrawal_amount',
    money: true,
    outflow: true,
    sub: (s) => ({
      key: 'dashboard.withdrawalsSub',
      values: { count: count(s.withdrawal_count) },
    }),
  },
];

/** Bar pair: this period against the previous one, scaled to the larger. */
const CompareBars = ({ cur, prev }: { cur: number; prev: number }) => {
  const { t } = useTranslation();
  const top = Math.max(cur, prev) || 1;
  const rows = [
    {
      label: t('dashboard.thisPeriod'),
      value: cur,
      fill: 'bg-ui-fg-interactive',
    },
    {
      label: t('dashboard.previousPeriod'),
      value: prev,
      fill: 'bg-ui-border-strong',
    },
  ];
  return (
    <div className="mt-3 flex flex-col gap-1.5" aria-hidden>
      {rows.map((r) => (
        <div
          key={r.label}
          className="grid grid-cols-[72px_1fr] items-center gap-2"
        >
          <Text size="xsmall" className="text-ui-fg-muted">
            {r.label}
          </Text>
          <div className="bg-ui-bg-component h-1.5 overflow-hidden rounded-full">
            <div
              className={`pc-grow h-full origin-left rounded-full ${r.fill}`}
              style={{ transform: `scaleX(${r.value / top})` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

/** The four headline figures for the picked window (GET /admin/stats). */
export const KpiTiles = ({
  report,
  failed = false,
}: {
  report: StatsReport | undefined;
  /** The stats query failed: a dash, not an endless skeleton. */
  failed?: boolean;
}) => {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {TILES.map((tile, i) => {
        const cur = report?.current.stats[tile.key];
        const prev = report?.previous.stats[tile.key];
        const sub = report ? tile.sub(report.current.stats) : undefined;
        return (
          <Container
            key={tile.key}
            className={`pc-settle flex flex-col ${['[animation-delay:60ms]', '[animation-delay:90ms]', '[animation-delay:120ms]', '[animation-delay:150ms]'][i]}`}
          >
            <div className="flex items-center justify-between gap-2">
              <Text size="small" className="text-ui-fg-subtle">
                {t(`statsBoard.${tile.key}`)}
              </Text>
              {cur !== undefined && prev !== undefined && (
                <DeltaBadge cur={cur} prev={prev} riseIsBad={tile.outflow} />
              )}
            </div>
            {cur === undefined || prev === undefined ? (
              <div className="mt-3">
                {failed ? (
                  <Text className="text-ui-fg-muted text-[28px] font-semibold">
                    —
                  </Text>
                ) : (
                  <LoadingSkeleton />
                )}
              </div>
            ) : (
              <>
                <Text className="mt-2 text-[28px] font-semibold leading-tight tabular-nums">
                  <CountUp value={cur} format={tile.money ? rm : count} />
                </Text>
                <Text
                  size="small"
                  className="text-ui-fg-subtle min-h-5 tabular-nums"
                >
                  {sub?.key
                    ? t(sub.key, sub.values)
                    : t('statsBoard.previous', {
                        value: tile.money ? rm(prev) : count(prev),
                      })}
                </Text>
                <CompareBars cur={cur} prev={prev} />
              </>
            )}
          </Container>
        );
      })}
    </div>
  );
};
