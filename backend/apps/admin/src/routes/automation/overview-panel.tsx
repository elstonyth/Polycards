import { useState } from 'react';
import { Badge, Button, Container, Heading, Table, Text } from '@medusajs/ui';
import {
  ArrowPath,
  Cash,
  FireSolid,
  Sparkles,
  SquareTwoStack,
} from '@medusajs/icons';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { orderDateTime, rm } from '../../lib/format';
import { prefersReducedMotion } from '../../lib/use-count-up';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { CountUp } from '../overview/KpiTiles';
import { TIER_ORDER, ago, tierColor } from './tiers';
import { useAutomationActivity } from './use-automation-activity';

// Generated, text-free key art (a graded slab in a burst of light).
const BIG_HIT_ART = new URL('./assets/big-hit.webp', import.meta.url).href;

const WINDOWS = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
] as const;
const GRID = 'var(--border-base)';
const TICK = { fill: 'var(--fg-subtle)', fontSize: 11 };
const count = (n: number) => Math.round(n).toLocaleString('en-US');

export function TierChip({ rarity }: { rarity: string }) {
  return (
    <span
      className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide text-white"
      style={{ backgroundColor: tierColor(rarity) }}
    >
      {rarity}
    </span>
  );
}

function Tile({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="bg-ui-bg-subtle flex flex-col gap-1 rounded-lg border px-4 py-3">
      <Text
        size="small"
        className="text-ui-fg-subtle flex items-center gap-1.5"
      >
        <span aria-hidden className="text-ui-fg-muted flex">
          {icon}
        </span>
        {label}
      </Text>
      <Text className="text-2xl font-semibold tabular-nums leading-tight">
        {value}
      </Text>
      {hint && (
        <Text size="xsmall" className="text-ui-fg-muted">
          {hint}
        </Text>
      )}
    </div>
  );
}

export function OverviewPanel() {
  const [days, setDays] = useState<number>(7);
  const activity = useAutomationActivity(days);
  const data = activity.data;
  const name = (id: string) => data?.names[id] ?? 'Unknown account';
  const total = data?.days.reduce(
    (sum, row) => ({
      draws: sum.draws + row.draws,
      valueMyr: sum.valueMyr + row.valueMyr,
      costMyr: sum.costMyr + row.costMyr,
      soldMyr: sum.soldMyr + row.soldMyr,
    }),
    { draws: 0, valueMyr: 0, costMyr: 0, soldMyr: 0 },
  );
  const bigHits = data?.accounts.reduce((sum, row) => sum + row.hits, 0) ?? 0;
  const tierDraws = TIER_ORDER.map((rarity) => ({
    rarity,
    draws: data?.tiers.find((row) => row.rarity === rarity)?.draws ?? 0,
  })).filter((row) => row.draws > 0);
  const animate = !prefersReducedMotion();

  return (
    <>
      <Container>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <Heading level="h2">What the bot accounts are doing</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              Every draw by accounts on the Accounts list, across all runs.
              Updates every 30 seconds.
            </Text>
          </div>
          <div className="flex gap-1" role="group" aria-label="Time range">
            {WINDOWS.map((window) => (
              <Button
                key={window.days}
                size="small"
                variant={days === window.days ? 'primary' : 'secondary'}
                aria-pressed={days === window.days}
                onClick={() => setDays(window.days)}
              >
                {window.label}
              </Button>
            ))}
          </div>
        </div>
        {activity.isError && (
          <Text role="alert" className="text-ui-fg-error mt-4">
            {activity.error.message}
          </Text>
        )}
        {!data || !total ? (
          <LoadingSkeleton className="mt-4" />
        ) : (
          <div
            className={`mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5 transition-opacity ${activity.isPlaceholderData ? 'opacity-50' : ''}`}
          >
            <Tile
              icon={<SquareTwoStack />}
              label="Packs opened"
              value={<CountUp value={total.draws} format={count} />}
            />
            <Tile
              icon={<Cash />}
              label="Spent on packs"
              value={<CountUp value={total.costMyr} format={rm} />}
              hint="At today's pack prices"
            />
            <Tile
              icon={<Sparkles />}
              label="Card value pulled"
              value={<CountUp value={total.valueMyr} format={rm} />}
            />
            <Tile
              icon={<ArrowPath />}
              label="Sold back for"
              value={<CountUp value={total.soldMyr} format={rm} />}
            />
            <Tile
              icon={<FireSolid className="text-ui-tag-red-icon" />}
              label="Legendary or better"
              value={<CountUp value={bigHits} format={count} />}
              hint={
                total.draws
                  ? `1 in ${count(total.draws / Math.max(bigHits, 1))} packs`
                  : undefined
              }
            />
          </div>
        )}
      </Container>

      <div className="grid gap-3 xl:grid-cols-3">
        <Container className="xl:col-span-2">
          <Heading level="h3">Packs opened per day</Heading>
          <Text size="xsmall" className="text-ui-fg-muted">
            Bars: packs opened · line: card value pulled (Malaysia time)
          </Text>
          {!data ? (
            <LoadingSkeleton className="mt-4" />
          ) : !data.days.length ? (
            <Text size="small" className="text-ui-fg-subtle py-10 text-center">
              No draws in this period yet.
            </Text>
          ) : (
            <>
              <ul className="sr-only">
                {data.days.map((row) => (
                  <li key={row.day}>
                    {row.day}: {row.draws} packs, {rm(row.valueMyr)} pulled
                  </li>
                ))}
              </ul>
              <div className="mt-3 h-64 w-full" aria-hidden>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={data.days.map((row) => ({
                      ...row,
                      label: row.day.slice(5),
                    }))}
                    margin={{ top: 8, right: 8, bottom: 0, left: -8 }}
                  >
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
                    />
                    <YAxis
                      yAxisId="draws"
                      tick={TICK}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                    />
                    <YAxis
                      yAxisId="value"
                      orientation="right"
                      tick={TICK}
                      tickLine={false}
                      axisLine={false}
                      width={56}
                      tickFormatter={(v: number) =>
                        v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)
                      }
                    />
                    <Tooltip
                      cursor={{ fill: 'var(--bg-subtle-hover)' }}
                      formatter={(value, key) =>
                        key === 'valueMyr'
                          ? [rm(Number(value)), 'Card value']
                          : [count(Number(value)), 'Packs']
                      }
                    />
                    <Bar
                      yAxisId="draws"
                      dataKey="draws"
                      fill={tierColor('Mythical', 0.75)}
                      radius={[4, 4, 0, 0]}
                      isAnimationActive={animate}
                    />
                    <Line
                      yAxisId="value"
                      type="monotone"
                      dataKey="valueMyr"
                      stroke={tierColor('Immortal')}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={animate}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Container>

        <Container>
          <Heading level="h3">What they pulled</Heading>
          <Text size="xsmall" className="text-ui-fg-muted">
            Share of packs by card tier
          </Text>
          {!data ? (
            <LoadingSkeleton className="mt-4" />
          ) : !tierDraws.length ? (
            <Text size="small" className="text-ui-fg-subtle py-10 text-center">
              Nothing pulled yet.
            </Text>
          ) : (
            <div className="mt-4 space-y-3">
              <div
                className="flex h-3 w-full overflow-hidden rounded-full"
                aria-hidden
              >
                {tierDraws.map((row) => (
                  <div
                    key={row.rarity}
                    style={{
                      width: `${(row.draws / total!.draws) * 100}%`,
                      backgroundColor: tierColor(row.rarity),
                    }}
                  />
                ))}
              </div>
              <ul className="space-y-2">
                {tierDraws.map((row) => (
                  <li
                    key={row.rarity}
                    className="flex items-center justify-between gap-3"
                  >
                    <TierChip rarity={row.rarity} />
                    <Text size="small" className="tabular-nums">
                      {count(row.draws)}{' '}
                      <span className="text-ui-fg-muted">
                        ·{' '}
                        {((row.draws / total!.draws) * 100).toLocaleString(
                          undefined,
                          { maximumFractionDigits: 2 },
                        )}
                        %
                      </span>
                    </Text>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Container>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Container className="p-0">
          <div className="relative flex min-h-28 flex-col justify-center overflow-hidden px-6 py-4">
            <img
              src={BIG_HIT_ART}
              alt=""
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 h-full w-1/2 object-cover object-[right_35%] [mask-image:linear-gradient(to_right,transparent,black_60%)]"
            />
            <Heading level="h3" className="relative flex items-center gap-1.5">
              <FireSolid aria-hidden className="text-ui-tag-red-icon" />
              Big hits: Legendary and above
            </Heading>
            <Text size="xsmall" className="text-ui-fg-muted relative">
              Who pulled it, from which pack, and when. Newest first.
            </Text>
          </div>
          {!data ? (
            <LoadingSkeleton className="px-6 pb-4" />
          ) : !data.hits.length ? (
            <Text size="small" className="text-ui-fg-subtle px-6 pb-8">
              No Legendary or better pulls in this period.
            </Text>
          ) : (
            <ul className="max-h-[480px] divide-y overflow-y-auto border-t">
              {data.hits.map((hit) => (
                <li
                  key={hit.id}
                  className="flex items-center gap-3 px-6 py-3"
                  style={{
                    boxShadow: `inset 3px 0 0 ${tierColor(hit.rarity)}`,
                  }}
                >
                  {hit.cardImage?.startsWith('http') ? (
                    <img
                      src={hit.cardImage}
                      alt=""
                      className="h-12 w-9 shrink-0 rounded object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div
                      aria-hidden
                      className="h-12 w-9 shrink-0 rounded"
                      style={{ backgroundColor: tierColor(hit.rarity, 0.25) }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <TierChip rarity={hit.rarity} />
                      <Text
                        size="small"
                        weight="plus"
                        className="min-w-0 truncate"
                      >
                        {hit.cardName ?? 'Unknown card'}
                      </Text>
                    </div>
                    <Text size="xsmall" className="text-ui-fg-subtle truncate">
                      {name(hit.customerId)} · {hit.packTitle ?? 'Unknown pack'}
                    </Text>
                  </div>
                  <div className="shrink-0 text-right">
                    <Text size="small" weight="plus" className="tabular-nums">
                      {rm(hit.valueMyr)}
                    </Text>
                    <Text size="xsmall" className="text-ui-fg-muted">
                      <time
                        dateTime={hit.rolledAt}
                        title={orderDateTime(hit.rolledAt)}
                      >
                        {ago(hit.rolledAt)}
                      </time>{' '}
                      · {hit.sold ? 'sold back' : 'kept'}
                    </Text>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Container>

        <Container className="p-0">
          <div className="px-6 py-4">
            <Heading level="h3">Top accounts</Heading>
            <Text size="xsmall" className="text-ui-fg-muted">
              Ranked by card value pulled in this period
            </Text>
          </div>
          {!data ? (
            <LoadingSkeleton className="px-6 pb-4" />
          ) : !data.accounts.length ? (
            <Text size="small" className="text-ui-fg-subtle px-6 pb-8">
              No account has opened a pack in this period.
            </Text>
          ) : (
            <div className="max-h-[480px] overflow-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Account</Table.HeaderCell>
                    <Table.HeaderCell>Packs</Table.HeaderCell>
                    <Table.HeaderCell>Value pulled</Table.HeaderCell>
                    <Table.HeaderCell>Big hits</Table.HeaderCell>
                    <Table.HeaderCell>Last pack</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.accounts.map((row, index) => (
                    <Table.Row key={row.customerId}>
                      <Table.Cell>
                        <span className="text-ui-fg-muted mr-2 tabular-nums">
                          {index + 1}
                        </span>
                        {name(row.customerId)}
                      </Table.Cell>
                      <Table.Cell className="tabular-nums">
                        {count(row.draws)}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap tabular-nums">
                        {rm(row.valueMyr)}
                      </Table.Cell>
                      <Table.Cell>
                        {row.hits ? (
                          <Badge size="2xsmall" color="purple">
                            <FireSolid aria-hidden className="size-3" />
                            {row.hits}
                          </Badge>
                        ) : (
                          <span className="text-ui-fg-muted">—</span>
                        )}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                        {ago(row.lastAt)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
        </Container>
      </div>
    </>
  );
}
