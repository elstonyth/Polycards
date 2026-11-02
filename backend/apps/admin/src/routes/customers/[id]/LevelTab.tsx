import { useTranslation } from 'react-i18next';
import { Badge, Container, Heading, Text } from '@medusajs/ui';
import { useCustomerGacha, useSpendReport } from '../../../lib/queries';
import { rm } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { StatTile } from './MoneyCards';

/** VIP level, progress to the next one, and pack spend month by month as
 *  bars, so a trend reads at a glance. */
export const LevelTab = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  // Same query key as the header's — served from cache, not a second request.
  const { data: view, isError: viewError } = useCustomerGacha(customerId);
  const { data: report, isError: reportError } = useSpendReport(customerId);
  const vip = view?.vip ?? null;
  const next = vip?.next ?? null;
  const periods = report?.periods ?? [];
  const top = Math.max(0, ...periods.map((p) => p.spend));

  // Clamped both ends: a 0 threshold would divide by zero, and spend can sit
  // PAST the next rung's threshold in the window between a qualifying purchase
  // and the level-up saga writing the new projection.
  const pct =
    next && next.threshold > 0
      ? Math.min(100, Math.max(0, (vip!.spend / next.threshold) * 100))
      : 100;

  return (
    <>
      <Container className="p-0">
        {viewError ? (
          <div className="px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !view ? (
          <div className="px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : !vip ? (
          // The ladder is empty or this player has never spent — there is no
          // level to draw, and a "LV 0 / 0% to LV 1" card would be a fiction.
          <div className="px-6 py-6">
            <Text className="text-ui-fg-subtle">{t('players.noLevel')}</Text>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-3 px-6 py-4">
              <Heading level="h1">
                {t('players.levelHeading', { level: vip.level })}
              </Heading>
              <Badge size="small" color="purple">
                {t('customer360.vipPeakLevel', {
                  level: vip.highest_level_ever,
                })}
              </Badge>
            </div>
            <div className="bg-ui-border-base grid grid-cols-1 gap-px border-t md:grid-cols-2">
              <StatTile
                label={t('customer360.vipSpend')}
                value={rm(vip.spend)}
              />
              <StatTile
                label={t('players.nextTier')}
                value={
                  next
                    ? t('players.levelHeading', { level: next.level })
                    : t('players.topTier')
                }
                note={
                  next ? (
                    <span className="flex flex-col gap-1.5">
                      {/* Native progress semantics without the element:
                          role+aria give a screen reader the same numbers. */}
                      <span
                        className="bg-ui-bg-component mt-1 block h-1.5 w-full overflow-hidden rounded-full"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(pct)}
                        aria-label={t('players.nextTier')}
                      >
                        <span
                          className="bg-ui-fg-interactive block h-full rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      {t('players.toNextLevel', {
                        amount: rm(next.remaining),
                        level: next.level,
                      })}
                    </span>
                  ) : undefined
                }
              />
            </div>
          </>
        )}
      </Container>

      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('players.spendReport')}</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            {t('playerDetail.spendReportNote')}
          </Text>
        </div>
        {reportError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !report ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : periods.length === 0 ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">{t('players.spendEmpty')}</Text>
          </div>
        ) : (
          <ul
            className="flex flex-col gap-2.5 border-t px-6 py-4"
            aria-label={t('players.spendReport')}
          >
            {periods.map((p) => (
              <li
                key={p.period}
                className="grid grid-cols-[4.5rem_minmax(0,1fr)_7.5rem] items-center gap-3"
              >
                <Text size="small" className="text-ui-fg-subtle tabular-nums">
                  {p.period}
                </Text>
                <div
                  className="bg-ui-bg-component h-2.5 overflow-hidden rounded-full"
                  aria-hidden
                >
                  <div
                    className="bg-ui-fg-interactive h-full rounded-full"
                    style={{
                      width: `${top > 0 ? Math.max(0, (p.spend / top) * 100) : 0}%`,
                    }}
                  />
                </div>
                <Text
                  size="small"
                  weight="plus"
                  className="text-right tabular-nums"
                >
                  {rm(p.spend)}
                </Text>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </>
  );
};
