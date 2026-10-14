import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@medusajs/ui';

/** "Live · updated 12s ago", ticking; the dot pulses while data is fresh. */
export const LiveBadge = ({ updatedAt }: { updatedAt: number }) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!updatedAt) return null;
  const secs = Math.max(0, Math.round((now - updatedAt) / 1000));
  return (
    <Text
      size="xsmall"
      className="text-ui-fg-subtle flex items-center gap-1.5 tabular-nums"
      aria-live="off"
    >
      <span className="pc-live-dot" aria-hidden />
      {secs < 5
        ? t('dashboard.liveNow')
        : t('dashboard.liveAgo', {
            ago: secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`,
          })}
    </Text>
  );
};
