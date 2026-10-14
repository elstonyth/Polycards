import { useTranslation } from 'react-i18next';
import { Button, Input, Text } from '@medusajs/ui';
import type { StatsRange } from '../../lib/admin-rest';
import { RANGES, todayMyt } from './helpers';

interface Props {
  range: StatsRange;
  onRange: (r: StatsRange) => void;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}

/** The Stats page's period presets (statsBoard.*, so zhCN keeps working). */
export const RangePicker = ({
  range,
  onRange,
  from,
  to,
  onFrom,
  onTo,
}: Props) => {
  const { t } = useTranslation();
  const custom = range === 'custom';
  // YYYY-MM-DD strings order correctly as plain strings.
  const customValid = from !== '' && to !== '' && from <= to;
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label={t('dashboard.title')}
      >
        {RANGES.map((r) => (
          <Button
            key={r}
            size="small"
            variant={range === r ? 'primary' : 'secondary'}
            aria-pressed={range === r}
            onClick={() => onRange(r)}
          >
            {t(`statsBoard.ranges.${r}`)}
          </Button>
        ))}
      </div>
      {custom && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            className="w-40"
            aria-label={t('statsBoard.from')}
            value={from}
            max={todayMyt()}
            onChange={(e) => onFrom(e.target.value)}
          />
          <Input
            type="date"
            className="w-40"
            aria-label={t('statsBoard.to')}
            value={to}
            onChange={(e) => onTo(e.target.value)}
          />
          {!customValid && (
            <Text size="small" className="text-ui-fg-subtle">
              {t('statsBoard.customHint')}
            </Text>
          )}
        </div>
      )}
    </div>
  );
};
