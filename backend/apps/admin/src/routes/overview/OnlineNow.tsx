import { useTranslation } from 'react-i18next';
import { Text, Tooltip } from '@medusajs/ui';
import type { CustomerScope } from '../../lib/admin-rest';
import { useOnlineNow } from '../../lib/queries';
import { isForbidden } from './helpers';
import { CountUp } from './KpiTiles';

const count = (n: number) => Math.round(n).toLocaleString('en-US');

/** "● 12 online now": signed-in players with the storefront open in the last
 *  5 minutes (GET /admin/stats/online), under the Dashboard's scope switch.
 *  useLiveRefresh refetches it every 30s: its key sits under admin/stats. */
export const OnlineNow = ({ scope }: { scope: CustomerScope }) => {
  const { t } = useTranslation();
  const online = useOnlineNow(scope);
  if (online.isError && isForbidden(online.error)) return null;
  const n = online.data?.online;
  return (
    <Tooltip content={t('dashboard.onlineHint')}>
      <Text
        as="span"
        size="small"
        tabIndex={0}
        className="flex items-center gap-1.5 tabular-nums"
      >
        <span className="pc-live-dot" aria-hidden />
        <span className="txt-compact-small-plus">
          {n == null ? (
            online.isError || online.data ? '—' : '…'
          ) : (
            <CountUp value={n} format={count} />
          )}
        </span>
        <span className="text-ui-fg-subtle">{t('dashboard.onlineNow')}</span>
      </Text>
    </Tooltip>
  );
};
