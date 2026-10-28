import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Container, Heading, Text } from '@medusajs/ui';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  CustomerScope,
  SettlementGranularity,
  StatsReport,
} from '../../lib/admin-rest';
import { useSettlementReport } from '../../lib/queries';
import { rm } from '../../lib/format';
import {
  amountChange,
  moneyFlowSeries,
  netCashIn,
  type FlowPoint,
} from '../../lib/dashboard';
import { prefersReducedMotion } from '../../lib/use-count-up';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { CountUp } from './KpiTiles';
import { isForbidden } from './helpers';
import { SectionError } from './SectionState';

// Theme-aware: Medusa UI's own variables, so the chart follows light/dark.
const IN = 'var(--tag-green-icon)';
const OUT = 'var(--fg-muted)';
const GRID = 'var(--border-base)';
const TICK = { fill: 'var(--fg-subtle)', fontSize: 11 };

const axisRm = (v: number) =>
  v >= 1000
    ? `${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
    : String(v);

const FlowTooltip = ({
  active,
  payload,
  granularity,
}: {
  active?: boolean;
  payload?: { payload: FlowPoint }[];
  granularity: SettlementGranularity;
}) => {
  const { t } = useTranslation();
  const p = active ? payload?.[0]?.payload : undefined;
  if (!p) return null;
  const rows = [
    { label: t('dashboard.moneyIn'), value: p.moneyIn },
    { label: t('dashboard.moneyOut'), value: p.moneyOut },
    { label: t('dashboard.net'), value: p.net },
  ];
  return (
    <div className="bg-ui-bg-base shadow-elevation-flyout min-w-44 rounded-lg px-3 py-2">
      <Text size="xsmall" className="text-ui-fg-subtle mb-1">
        {granularity === 'week'
          ? t('dashboard.weekOf', { label: p.label })
          : p.label}
      </Text>
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between gap-4">
          <Text size="xsmall">{r.label}</Text>
          <Text size="xsmall" weight="plus" className="tabular-nums">
            {rm(r.value)}
          </Text>
        </div>
      ))}
    </div>
  );
};

/** Net cash can go negative, so the change shows in RM, not %. */
export const NetChange = ({ cur, prev }: { cur: number; prev: number }) => {
  const { diff, tone } = amountChange(cur, prev);
  const color = tone === 'good' ? 'green' : tone === 'bad' ? 'red' : 'grey';
  return (
    <Badge size="2xsmall" color={color} className="tabular-nums">
      {diff === 0 ? '—' : `${diff > 0 ? '▲' : '▼'} ${rm(Math.abs(diff))}`}
    </Badge>
  );
};

/** Headline net cash in (picked window) over the 12-period money chart. */
export const MoneyFlowCard = ({
  scope = 'all',
  stats,
  statsStale = false,
  statsFailed = false,
  className = '',
}: {
  /** Real customers only, or every account (the Dashboard's switch). */
  scope?: CustomerScope;
  stats: StatsReport | undefined;
  /** `stats` is the previous scope or period's, kept while the new loads. */
  statsStale?: boolean;
  /** The stats query failed: show a dash, not an endless skeleton. */
  statsFailed?: boolean;
  className?: string;
}) => {
  const { t } = useTranslation();
  const [granularity, setGranularity] = useState<SettlementGranularity>('week');
  // '' = every rail, in RM (the route's default scope).
  const flow = useSettlementReport(granularity, 12, '', scope);
  const series = moneyFlowSeries(flow.data);
  const animate = !prefersReducedMotion();
  const net = stats ? netCashIn(stats.current.stats) : undefined;
  const prevNet = stats ? netCashIn(stats.previous.stats) : undefined;
  // Either half still shows the previous scope or period: dim the card.
  const stale = statsStale || flow.isPlaceholderData;

  return (
    <Container
      className={`pc-settle flex flex-col gap-4 transition-opacity ${stale ? 'opacity-50' : ''} ${className}`}
      aria-busy={stale}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Text size="small" className="text-ui-fg-subtle">
            {t('dashboard.netCash')}{' '}
            <span className="text-ui-fg-muted">
              · {t('dashboard.netCashHint')}
            </span>
          </Text>
          {statsFailed && !stats ? (
            <Text className="text-ui-fg-muted mt-1 text-[36px] font-semibold leading-tight">
              —
            </Text>
          ) : net === undefined || prevNet === undefined ? (
            <div className="mt-2 w-40">
              <LoadingSkeleton />
            </div>
          ) : (
            <>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <Text className="text-[36px] font-semibold leading-tight tabular-nums">
                  <CountUp value={net} format={rm} />
                </Text>
                <NetChange cur={net} prev={prevNet} />
              </div>
              <Text size="small" className="text-ui-fg-muted tabular-nums">
                {t('dashboard.previous', { value: rm(prevNet) })}
              </Text>
            </>
          )}
        </div>
        <div
          className="flex gap-1"
          role="group"
          aria-label={t('dashboard.flowTitle')}
        >
          {(['week', 'month'] as const).map((g) => (
            <Button
              key={g}
              size="small"
              variant={granularity === g ? 'primary' : 'secondary'}
              aria-pressed={granularity === g}
              onClick={() => setGranularity(g)}
            >
              {t(g === 'week' ? 'dashboard.weeks' : 'dashboard.months')}
            </Button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Heading level="h3">{t('dashboard.flowTitle')}</Heading>
          <div className="flex gap-4">
            <Text
              size="xsmall"
              className="text-ui-fg-subtle flex items-center gap-1.5"
            >
              <span className="bg-ui-tag-green-icon inline-block size-2 rounded-sm" />
              {t('dashboard.moneyIn')}
            </Text>
            <Text
              size="xsmall"
              className="text-ui-fg-subtle flex items-center gap-1.5"
            >
              <span className="bg-ui-fg-muted inline-block size-2 rounded-sm" />
              {t('dashboard.moneyOut')}
            </Text>
          </div>
        </div>
        <Text size="xsmall" className="text-ui-fg-muted">
          {t('dashboard.flowHint')}
        </Text>
      </div>

      {flow.isError && isForbidden(flow.error) ? null : flow.isError ? (
        <SectionError onRetry={() => void flow.refetch()} />
      ) : !flow.data ? (
        <LoadingSkeleton />
      ) : series.every((p) => p.moneyIn === 0 && p.moneyOut === 0) ? (
        <Text size="small" className="text-ui-fg-subtle py-10 text-center">
          {t('dashboard.noFlow')}
        </Text>
      ) : (
        <>
          <ul className="sr-only">
            {series.map((p) => (
              <li key={p.key}>
                {p.label}: {t('dashboard.moneyIn')} {rm(p.moneyIn)},{' '}
                {t('dashboard.moneyOut')} {rm(p.moneyOut)}
              </li>
            ))}
          </ul>
          <div className="h-64 w-full" aria-hidden>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={series}
                margin={{ top: 8, right: 8, bottom: 0, left: -8 }}
              >
                <defs>
                  <linearGradient id="pc-flow-in" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={IN} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={IN} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  vertical={false}
                  stroke={GRID}
                  strokeDasharray="3 5"
                />
                <XAxis
                  dataKey="label"
                  tick={TICK}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={16}
                />
                <YAxis
                  tick={TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={axisRm}
                  width={48}
                />
                <Tooltip
                  cursor={{ stroke: GRID, strokeDasharray: '3 4' }}
                  content={<FlowTooltip granularity={flow.data.granularity} />}
                />
                <Area
                  type="monotone"
                  dataKey="moneyIn"
                  stroke={IN}
                  strokeWidth={2}
                  fill="url(#pc-flow-in)"
                  isAnimationActive={animate}
                  animationDuration={900}
                />
                <Line
                  type="monotone"
                  dataKey="moneyOut"
                  stroke={OUT}
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={false}
                  isAnimationActive={animate}
                  animationDuration={900}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Container>
  );
};
